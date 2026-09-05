// src/routes/carePlans.js
// AI-drafted, date-specific care plans. Runs AFTER resolveTenant, so
// req.tenantId is already trusted — every query below is scoped to it.

const express = require("express");
const multer = require("multer");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5";

// Uploaded reference documents (physician's orders, discharge summaries,
// assessment forms) are small and occasional — kept in memory just long
// enough to forward to the AI provider and persist to Postgres, never
// written to local disk.
const ACCEPTED_DOCUMENT_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — plenty for a scanned form, keeps Postgres rows small
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_DOCUMENT_TYPES.has(file.mimetype)) {
      return cb(new Error("Only PDF or image (PNG/JPEG/WEBP) files are supported."));
    }
    cb(null, true);
  },
});

function buildPrompt(resident, planDate, sourceNotes, hasDocument) {
  const dateLabel = new Date(planDate).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const extraContext = [];
  if (sourceNotes) {
    extraContext.push(`Additional resident-specific notes provided by staff:\n${sourceNotes}`);
  }
  if (hasDocument) {
    extraContext.push(
      "A reference document (e.g. physician's order, discharge summary, or assessment form) is attached — use its contents to inform the plan."
    );
  }

  return `You are drafting a daily care plan for a resident of a licensed Adult Family Home (AFH) in Washington State. This is a DRAFT for a caregiver to review, edit, and sign off on — not a substitute for clinical judgment.

Resident: ${resident.name}
Care level: ${resident.careLevel}
Payer type: ${resident.payerType}
Move-in date: ${new Date(resident.moveInDate).toLocaleDateString()}
Plan date: ${dateLabel}
${extraContext.length ? `\n${extraContext.join("\n\n")}\n` : ""}
Write a concise, practical care plan for this specific date, covering:
1. Activities of Daily Living (ADL) support appropriate to the care level (bathing, dressing, mobility, toileting)
2. A medication/health-check reminder schedule${
    hasDocument || sourceNotes
      ? " (use specifics from the notes/document above where relevant)"
      : ' (generic placeholders like "morning medications," "vitals check" — do not invent specific drug names or dosages, since none were provided)'
  }
3. Nutrition/meal notes
4. Safety and mobility considerations
5. Social/emotional engagement for the day

Format as short labeled sections with bullet points. Keep it under 300 words. ${
    hasDocument || sourceNotes
      ? "Ground clinical specifics in the notes/document provided above — do not invent anything beyond what's given there."
      : "Do not fabricate specific medical diagnoses, medications, or allergies — flag where the caregiver should fill in resident-specific clinical details you don't have."
  }`;
}

router.get("/", async (req, res) => {
  const { residentId } = req.query;
  if (!residentId) {
    return res.status(400).json({ error: "residentId is required." });
  }
  const plans = await prisma.carePlan.findMany({
    where: { tenantId: req.tenantId, residentId },
    // Same-day regenerations tie on planDate — break ties by createdAt so the
    // most recent generation for that date always sorts first.
    orderBy: [{ planDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      residentId: true,
      planDate: true,
      content: true,
      model: true,
      createdAt: true,
      sourceNotes: true,
      sourceDocumentName: true,
      // sourceDocumentData deliberately excluded — callers don't need the raw
      // bytes back, just the fact that a document informed this plan.
    },
  });
  res.json(plans);
});

// GET /care-plans/:id/document — the raw uploaded reference document for one
// generation, for the resident profile's Documents tab.
router.get("/:id/document", async (req, res) => {
  const plan = await prisma.carePlan.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
    select: { sourceDocumentName: true, sourceDocumentMimeType: true, sourceDocumentData: true },
  });
  if (!plan || !plan.sourceDocumentData) {
    return res.status(404).json({ error: "No document found for this care plan." });
  }
  res.set("Content-Type", plan.sourceDocumentMimeType || "application/octet-stream");
  res.set("Content-Disposition", `inline; filename="${plan.sourceDocumentName || "document"}"`);
  res.send(plan.sourceDocumentData);
});

router.post("/generate", upload.single("document"), async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: "AI provider not configured — set ANTHROPIC_API_KEY on the backend to enable care plan generation.",
    });
  }

  const { residentId, planDate, notes } = req.body;
  if (!residentId || !planDate) {
    return res.status(400).json({ error: "residentId and planDate are required." });
  }

  const resident = await prisma.resident.findFirst({
    where: { id: residentId, tenantId: req.tenantId },
  });
  if (!resident) {
    return res.status(404).json({ error: "Resident not found." });
  }

  const file = req.file;
  const sourceNotes = notes?.trim() || null;

  const promptText = buildPrompt(resident, planDate, sourceNotes, !!file);
  const userContent = [{ type: "text", text: promptText }];
  if (file) {
    const isPdf = file.mimetype === "application/pdf";
    userContent.push({
      type: isPdf ? "document" : "image",
      source: { type: "base64", media_type: file.mimetype, data: file.buffer.toString("base64") },
    });
  }

  let content;
  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `AI provider returned ${aiRes.status}`);
    }

    const aiBody = await aiRes.json();
    content = aiBody.content?.[0]?.text;
    if (!content) throw new Error("AI provider returned an empty response.");
  } catch (err) {
    return res.status(502).json({ error: `Care plan generation failed: ${err.message}` });
  }

  const plan = await prisma.carePlan.create({
    data: {
      tenantId: req.tenantId,
      residentId,
      planDate: new Date(planDate),
      content,
      model: MODEL,
      sourceNotes,
      sourceDocumentName: file?.originalname || null,
      sourceDocumentMimeType: file?.mimetype || null,
      sourceDocumentData: file?.buffer || null,
    },
    select: {
      id: true,
      residentId: true,
      planDate: true,
      content: true,
      model: true,
      createdAt: true,
      sourceNotes: true,
      sourceDocumentName: true,
    },
  });

  res.status(201).json(plan);
});

// Multer errors (bad file type, too large) land here instead of the generic
// error handler so the frontend gets a clear, expected-shape JSON error.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes("PDF or image")) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
