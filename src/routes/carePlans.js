// src/routes/carePlans.js
// AI-drafted Negotiated Care Plans (NCP), in the DSHS AFH HCS NCP template's
// section structure. A resident has one living plan — each generation is a
// new revision that updates the previous one rather than replacing it from
// scratch (see buildPrompt's previousPlan handling). Runs AFTER
// resolveTenant, so req.tenantId is already trusted — every query below is
// scoped to it.

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

// Section structure mirrors the WA DSHS "AFH HCS Resident Negotiated Care
// Plan (NCP)" form — not a daily reminder. An NCP is a living document: it's
// drafted once and then updated (never regenerated from scratch) whenever
// something about the resident changes, or at least every 12 months. See
// buildPrompt's previousPlan handling below.
function buildPrompt(resident, sourceNotes, hasDocument, previousPlan) {
  const age = resident.dateOfBirth
    ? Math.floor((Date.now() - new Date(resident.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
    : null;

  const facts = [
    `Resident: ${resident.name}`,
    age !== null ? `Age: ${age} (DOB ${new Date(resident.dateOfBirth).toLocaleDateString()})` : null,
    `Room: ${resident.room || "not recorded"}`,
    `Care level: ${resident.careLevel}`,
    `Payer type: ${resident.payerType}${resident.medicaidSplitPct ? ` (Medicaid ${resident.medicaidSplitPct}%)` : ""}`,
    `Move-in date: ${new Date(resident.moveInDate).toLocaleDateString()}`,
  ]
    .filter(Boolean)
    .join("\n");

  const extraContext = [];
  if (previousPlan) {
    extraContext.push(
      `This resident already has a Negotiated Care Plan on file, drafted ${new Date(
        previousPlan.createdAt
      ).toLocaleDateString()}. UPDATE it — keep every section/detail that's still accurate, and only change what the new information below actually changes. Do not delete or invent details beyond what's given.\n\nCURRENT PLAN ON FILE:\n${
        previousPlan.content
      }`
    );
  }
  if (sourceNotes) {
    extraContext.push(`New information from staff:\n${sourceNotes}`);
  }
  if (hasDocument) {
    extraContext.push(
      "A reference document (e.g. physician's order, discharge summary, or assessment form) is attached — use its contents to inform the plan."
    );
  }

  const hasGrounding = hasDocument || sourceNotes || previousPlan;

  return `You are drafting a Negotiated Care Plan (NCP) for a resident of a licensed Adult Family Home (AFH) in Washington State, following the same section structure as the DSHS AFH HCS Negotiated Care Plan template. This is a DRAFT for the provider/caregiver to review, correct, and sign — not a substitute for a real clinical or DSHS-required assessment.

${facts}
${extraContext.length ? `\n${extraContext.join("\n\n")}\n` : ""}
Write the plan using exactly these section headers, each alone on its own line starting with "## ", in this order:
## RESIDENT SUMMARY
## EMERGENCY EVACUATION
## MEDICAL STATUS / DIAGNOSIS OVERVIEW
## COMMUNICATION (SPEECH / HEARING / VISION)
## MEDICATION MANAGEMENT
## HEALTH INDICATORS
## TREATMENTS / PROGRAMS / THERAPIES
## PSYCH / SOCIAL / COGNITIVE STATUS AND BEHAVIOR
## ABILITY TO BE LEFT ALONE
## UNIVERSAL PRECAUTIONS
## ACTIVITIES OF DAILY LIVING
## INSTRUMENTAL ACTIVITIES OF DAILY LIVING
## ACTIVITY PREFERENCES
## SMOKING
## CASE MANAGEMENT / RESPONSIBLE PARTIES
## OTHER ISSUES / CONCERNS
## PLAN REVIEW

Format ACTIVITIES OF DAILY LIVING and INSTRUMENTAL ACTIVITIES OF DAILY LIVING as a markdown table, matching the DSHS template's own layout, with exactly these three columns:
| Domain | Strengths & Preferences | Assistance Required / Caregiver Will |
|---|---|---|
Under ACTIVITIES OF DAILY LIVING, one row per domain for: Ambulation/Mobility, Bed Mobility/Transfer, Eating, Toileting/Continence, Dressing, Personal Hygiene, Bathing, Foot Care, Skin Care.
Under INSTRUMENTAL ACTIVITIES OF DAILY LIVING, one row per domain for: Managing Finances, Shopping, Transportation, Activities/Social. For Managing Finances, whenever the resident needs full assistance managing their finances, the Assistance Required / Caregiver Will cell must state that staff provide full assistance with financial management on the resident's behalf, AND that all transactions and financial records must be independently verified (double-checked) by a second staff member — a standard safeguard against errors or financial exploitation.

Format RESIDENT SUMMARY as a flat list of "**Label:** value" lines (one per line, no bullets) — Name, Date of Birth/Age, Room, Move-in Date, Care Level, Payer, Allergies, Legal Documents, Specialty Needs.

For PLAN REVIEW, write exactly this standard note: this NCP will be reviewed after any significant change in the resident's condition, when it no longer reflects the resident's needs or preferences, at the resident's request, or at least every twelve months — whichever comes first.

For every other section, use short bullet points ("- ") or short paragraphs. ${
    hasGrounding
      ? "Ground every clinical specific (diagnoses, medications, behaviors, allergies) only in what's provided above — do not invent anything beyond it."
      : 'Do not fabricate any specific diagnosis, medication, allergy, or behavior. For every section where no information was provided, write exactly: "Not yet assessed — caregiver to complete."'
  }
Do not use checkboxes or brackets. Do not include a title, date, or preamble — start directly with the first "## " header.`;
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

  const previousPlan = await prisma.carePlan.findFirst({
    where: { residentId, tenantId: req.tenantId },
    orderBy: [{ planDate: "desc" }, { createdAt: "desc" }],
  });

  const promptText = buildPrompt(resident, sourceNotes, !!file, previousPlan);
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
        max_tokens: 4096, // a full NCP covers ~17 sections — needs more room than the old daily-reminder plan did
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
