// src/routes/onboarding.js
const express = require("express");
const multer = require("multer");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5";

// Verification documents (IDs, certificates, background check letters) are
// small and occasional — kept in memory just long enough to forward to the
// AI provider and persist to Postgres, never written to local disk.
const ACCEPTED_DOCUMENT_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_DOCUMENT_TYPES.has(file.mimetype)) {
      return cb(new Error("Only PDF or image (PNG/JPEG/WEBP) files are supported."));
    }
    cb(null, true);
  },
});

// The actual WA AFH new-hire checklist, seeded once per tenant. Conditional
// items (NAR, Dementia/Mental Health/Developmental Disabilities certs) are
// in the library but NOT auto-instantiated for every hire — a manager adds
// them to a specific employee only when they actually apply.
const CHECKLIST_TEMPLATES = [
  { name: "Obtain I.D.", deadlineType: "fixed_days", deadlineDays: 1, sortOrder: 1, requiresDocument: true },
  { name: "Run background check", deadlineType: "fixed_days", deadlineDays: 1, sortOrder: 2 },
  { name: "Schedule fingerprint", deadlineType: "fixed_days", deadlineDays: null, dependsOnName: "Run background check", sortOrder: 3 },
  { name: "TB testing to start", deadlineType: "fixed_days", deadlineDays: 3, sortOrder: 4 },
  { name: "Orientation and Safety Certificate (5-hour)", deadlineType: "gate", gateName: "before_providing_care", sortOrder: 5 },
  { name: "Facility Orientation", deadlineType: "gate", gateName: "before_routine_interaction", sortOrder: 6 },
  { name: "Background check (satisfactory result)", deadlineType: "gate", gateName: "before_unsupervised_care", sortOrder: 7, requiresDocument: true },
  { name: "CPR and First Aid card (hands-on only)", deadlineType: "gate", gateName: "before_unsupervised_care", sortOrder: 8, requiresDocument: true, credentialType: "cpr_first_aid" },
  // Also gates unsupervised care on the paper checklist (same section as
  // Background check/CPR&First Aid) in addition to its own 120-day deadline
  // — kept as fixed_days since deadlineDays is what actually drives the
  // overdue calculation, but gateName carries the compliance context through.
  { name: "75-hour Basic Training Certificate", deadlineType: "fixed_days", deadlineDays: 120, gateName: "before_unsupervised_care", sortOrder: 9, requiresDocument: true, credentialType: "basic_training_75hr" },
  { name: "NAR application", deadlineType: "conditional", isConditional: true, sortOrder: 10 },
  { name: "HCA application", deadlineType: "fixed_days", deadlineDays: 14, sortOrder: 11 },
  { name: "Food Worker Card or Food Handling CE", deadlineType: "fixed_days", deadlineDays: 14, sortOrder: 12, requiresDocument: true, credentialType: "food_worker_card" },
  { name: "Dementia Certificate", deadlineType: "conditional", isConditional: true, deadlineDays: 90, sortOrder: 13, requiresDocument: true, credentialType: "dementia_certificate" },
  { name: "Mental Health Certificate", deadlineType: "conditional", isConditional: true, deadlineDays: 90, sortOrder: 14, requiresDocument: true, credentialType: "mental_health_certificate" },
  { name: "Developmental Disabilities Certificate", deadlineType: "conditional", isConditional: true, deadlineDays: 90, sortOrder: 15, requiresDocument: true, credentialType: "developmental_disabilities_certificate" },
  { name: "Fingerprint Report (satisfactory result)", deadlineType: "fixed_days", deadlineDays: 120, sortOrder: 16, requiresDocument: true },
  { name: "HCA Certificate", deadlineType: "fixed_days", deadlineDays: 200, sortOrder: 17, requiresDocument: true, credentialType: "hca_certificate" },
];

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Shared by the manual seed endpoint below and instantiate's lazy fallback.
// Assumes the caller already checked no templates exist for this tenant.
async function seedTemplatesForTenant(tenantId) {
  const idsByName = {};
  // Insert non-dependent templates first, then dependent ones, so dependsOnId can resolve
  const withoutDeps = CHECKLIST_TEMPLATES.filter((t) => !t.dependsOnName);
  const withDeps = CHECKLIST_TEMPLATES.filter((t) => t.dependsOnName);

  for (const t of withoutDeps) {
    const created = await prisma.onboardingRequirementTemplate.create({
      data: {
        tenantId,
        name: t.name,
        deadlineType: t.deadlineType,
        deadlineDays: t.deadlineDays ?? null,
        gateName: t.gateName ?? null,
        isConditional: !!t.isConditional,
        requiresDocument: !!t.requiresDocument,
        credentialType: t.credentialType ?? null,
        sortOrder: t.sortOrder,
      },
    });
    idsByName[t.name] = created.id;
  }
  for (const t of withDeps) {
    const created = await prisma.onboardingRequirementTemplate.create({
      data: {
        tenantId,
        name: t.name,
        deadlineType: t.deadlineType,
        deadlineDays: t.deadlineDays ?? null,
        requiresDocument: !!t.requiresDocument,
        credentialType: t.credentialType ?? null,
        dependsOnId: idsByName[t.dependsOnName],
        sortOrder: t.sortOrder,
      },
    });
    idsByName[t.name] = created.id;
  }

  return Object.keys(idsByName).length;
}

// Self-healing counterpart to seedTemplatesForTenant: tenants seeded before
// requiresDocument/credentialType existed have templates missing those
// flags. Bringing every template's flags in line with CHECKLIST_TEMPLATES on
// each checklist view means no manual DB migration/backfill is ever needed —
// same "fix it lazily, the moment it matters" approach as the lazy seeding
// above. Matching is by name, scoped to this tenant only.
async function syncTemplateFlags(tenantId) {
  await Promise.all(
    CHECKLIST_TEMPLATES.map((t) =>
      prisma.onboardingRequirementTemplate.updateMany({
        where: { tenantId, name: t.name },
        data: { requiresDocument: !!t.requiresDocument, credentialType: t.credentialType ?? null },
      })
    )
  );
}

// POST /onboarding/seed-templates — kept for manual/admin use, but no longer
// load-bearing for normal operation: instantiate (below) seeds automatically
// the first time it's needed, so a new tenant never has to know this exists.
router.post("/seed-templates", async (req, res) => {
  const existing = await prisma.onboardingRequirementTemplate.findMany({
    where: { tenantId: req.tenantId },
  });
  if (existing.length > 0) {
    return res.status(409).json({ error: "Templates already seeded for this tenant.", count: existing.length });
  }

  const seeded = await seedTemplatesForTenant(req.tenantId);
  res.status(201).json({ seeded });
});

// POST /employees/:employeeId/onboarding/instantiate — run once when an
// employee is hired. Only non-conditional requirements are auto-created.
router.post("/employees/:employeeId/instantiate", async (req, res) => {
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.employeeId, tenantId: req.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found." });

  // A tenant's requirement library is seeded lazily, the first time anyone
  // actually needs it, rather than requiring a separate manual setup step
  // (or a raw "call /onboarding/seed-templates first" error) that a new
  // business owner would have no way to know about.
  const templateCount = await prisma.onboardingRequirementTemplate.count({
    where: { tenantId: req.tenantId },
  });
  if (templateCount === 0) {
    await seedTemplatesForTenant(req.tenantId);
  }

  const templates = await prisma.onboardingRequirementTemplate.findMany({
    where: { tenantId: req.tenantId, isConditional: false },
  });

  const items = templates.map((t) => ({
    tenantId: req.tenantId,
    employeeId: employee.id,
    templateId: t.id,
    dueDate: t.deadlineType === "fixed_days" && t.deadlineDays !== null
      ? addDays(employee.hireDate, t.deadlineDays)
      : null,
  }));

  await prisma.employeeOnboardingItem.createMany({ data: items, skipDuplicates: true });
  res.status(201).json({ instantiated: items.length });
});

// POST /employees/:employeeId/onboarding/add-conditional — a manager adds a
// conditional requirement (NAR, Dementia cert, etc.) once it's known to apply.
router.post("/employees/:employeeId/add-conditional", async (req, res) => {
  const { templateName } = req.body;
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.employeeId, tenantId: req.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found." });

  const template = await prisma.onboardingRequirementTemplate.findFirst({
    where: { tenantId: req.tenantId, name: templateName, isConditional: true },
  });
  if (!template) return res.status(404).json({ error: "Conditional requirement template not found." });

  const dueDate = template.deadlineDays ? addDays(employee.hireDate, template.deadlineDays) : null;
  const item = await prisma.employeeOnboardingItem.create({
    data: { tenantId: req.tenantId, employeeId: employee.id, templateId: template.id, dueDate },
  });
  res.status(201).json(item);
});

// GET /employees/:employeeId/onboarding — the checklist view, with computed
// status per item (done / overdue / blocked / pending).
router.get("/employees/:employeeId", async (req, res) => {
  await syncTemplateFlags(req.tenantId);

  const items = await prisma.employeeOnboardingItem.findMany({
    where: { tenantId: req.tenantId, employeeId: req.params.employeeId },
    include: { template: true },
    orderBy: { template: { sortOrder: "asc" } },
  });

  // Build a lookup of completion status by templateId, for dependency checks
  const completedByTemplateId = new Set(
    items.filter((i) => i.completedAt).map((i) => i.templateId)
  );

  const withStatus = items.map((item) => {
    let status;
    if (item.completedAt) {
      status = "done";
    } else if (item.template.dependsOnId && !completedByTemplateId.has(item.template.dependsOnId)) {
      status = "blocked"; // e.g. fingerprint can't proceed until background check clears
    } else if (item.dueDate && new Date(item.dueDate) < new Date()) {
      status = "overdue";
    } else {
      status = "pending";
    }
    return {
      id: item.id,
      name: item.template.name,
      deadlineType: item.template.deadlineType,
      gateName: item.template.gateName,
      dueDate: item.dueDate,
      completedAt: item.completedAt,
      requiresDocument: item.template.requiresDocument,
      credentialType: item.template.credentialType,
      verifiedName: item.verifiedName,
      verifiedExpirationDate: item.verifiedExpirationDate,
      documentName: item.documentName,
      status,
    };
  });

  res.json(withStatus);
});

// PATCH /onboarding/:itemId/complete — plain checkbox items only (no
// document to verify). requiresDocument items must go through .../verify
// below, so completion always carries the confirmed name/expiration data.
router.patch("/:itemId/complete", async (req, res) => {
  const item = await prisma.employeeOnboardingItem.findFirst({
    where: { id: req.params.itemId, tenantId: req.tenantId },
    include: { template: true },
  });
  if (!item) return res.status(404).json({ error: "Onboarding item not found." });

  if (item.template.requiresDocument) {
    return res.status(400).json({ error: `"${item.template.name}" requires uploading and verifying a document.` });
  }

  // Enforce the dependency gate server-side too — the UI shouldn't be the
  // only thing stopping someone from marking a blocked item complete.
  if (item.template.dependsOnId) {
    const dependency = await prisma.employeeOnboardingItem.findFirst({
      where: { employeeId: item.employeeId, templateId: item.template.dependsOnId },
    });
    if (!dependency?.completedAt) {
      return res.status(400).json({ error: `Complete "${item.template.name}"'s prerequisite first.` });
    }
  }

  const updated = await prisma.employeeOnboardingItem.update({
    where: { id: item.id },
    data: { completedAt: new Date() },
  });
  res.json(updated);
});

// POST /onboarding/:itemId/extract — AI-assisted prefill from the uploaded
// document, doesn't save anything. The frontend shows the extracted fields
// for a manager to review/edit before confirming via .../verify.
router.post("/:itemId/extract", upload.single("document"), async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "AI provider not configured — set ANTHROPIC_API_KEY on the backend." });
  }
  const item = await prisma.employeeOnboardingItem.findFirst({
    where: { id: req.params.itemId, tenantId: req.tenantId },
    include: { template: true },
  });
  if (!item) return res.status(404).json({ error: "Onboarding item not found." });
  if (!item.template.requiresDocument) {
    return res.status(400).json({ error: `"${item.template.name}" doesn't require a document.` });
  }
  const file = req.file;
  if (!file) return res.status(400).json({ error: "A document file is required." });

  const prompt = `Extract structured data from this document, which should be a "${item.template.name}" for a caregiver employed at a licensed Adult Family Home. Respond with ONLY a JSON object, no markdown, no explanation, in exactly this shape:
{"name": string or null, "expirationDate": "YYYY-MM-DD" or null}

"name" is the full name of the person the document belongs to. "expirationDate" is the expiration/renewal date printed on the document, if any (some documents, like background check or fingerprint results, have no expiration — use null). If a field isn't legible or present, use null for it.`;

  try {
    const isPdf = file.mimetype === "application/pdf";
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: isPdf ? "document" : "image",
                source: { type: "base64", media_type: file.mimetype, data: file.buffer.toString("base64") },
              },
            ],
          },
        ],
      }),
    });
    if (!aiRes.ok) {
      const errBody = await aiRes.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `AI provider returned ${aiRes.status}`);
    }
    const aiBody = await aiRes.json();
    const text = aiBody.content?.[0]?.text;
    if (!text) throw new Error("AI provider returned an empty response.");

    // Claude sometimes wraps JSON in a markdown fence despite instructions.
    const cleaned = text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const extracted = JSON.parse(cleaned);
    res.json(extracted);
  } catch (err) {
    res.status(502).json({ error: `Document scan failed: ${err.message}` });
  }
});

// POST /onboarding/:itemId/verify — the real save. Requires a confirmed
// name (and, for items tied to a renewable credential, an expiration date)
// plus the document itself, which is kept for future reference. Marks the
// item done and, if this template is tied to a Credential type, also
// creates that Credential so it shows up in the Credentials page's expiry
// tracking without the manager re-entering it.
router.post("/:itemId/verify", upload.single("document"), async (req, res) => {
  const item = await prisma.employeeOnboardingItem.findFirst({
    where: { id: req.params.itemId, tenantId: req.tenantId },
    include: { template: true },
  });
  if (!item) return res.status(404).json({ error: "Onboarding item not found." });
  if (!item.template.requiresDocument) {
    return res.status(400).json({ error: `"${item.template.name}" doesn't require a document.` });
  }

  const { name, expirationDate } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: "A document file is required." });
  if (!name?.trim()) return res.status(400).json({ error: "A confirmed name is required." });
  if (item.template.credentialType && !expirationDate) {
    return res.status(400).json({ error: `${item.template.name} requires a confirmed expiration date.` });
  }

  if (item.template.dependsOnId) {
    const dependency = await prisma.employeeOnboardingItem.findFirst({
      where: { employeeId: item.employeeId, templateId: item.template.dependsOnId },
    });
    if (!dependency?.completedAt) {
      return res.status(400).json({ error: `Complete "${item.template.name}"'s prerequisite first.` });
    }
  }

  const updated = await prisma.employeeOnboardingItem.update({
    where: { id: item.id },
    data: {
      completedAt: new Date(),
      verifiedName: name.trim(),
      verifiedExpirationDate: expirationDate ? new Date(expirationDate) : null,
      documentName: file.originalname,
      documentMimeType: file.mimetype,
      documentData: file.buffer,
    },
  });

  if (item.template.credentialType && expirationDate) {
    await prisma.credential.create({
      data: {
        tenantId: req.tenantId,
        employeeId: item.employeeId,
        credentialType: item.template.credentialType,
        issueDate: new Date(),
        expirationDate: new Date(expirationDate),
      },
    });
  }

  res.json(updated);
});

// GET /onboarding/:itemId/document — the uploaded verification document.
router.get("/:itemId/document", async (req, res) => {
  const item = await prisma.employeeOnboardingItem.findFirst({
    where: { id: req.params.itemId, tenantId: req.tenantId },
    select: { documentName: true, documentMimeType: true, documentData: true },
  });
  if (!item || !item.documentData) {
    return res.status(404).json({ error: "No document found for this onboarding item." });
  }
  res.set("Content-Type", item.documentMimeType || "application/octet-stream");
  res.set("Content-Disposition", `inline; filename="${item.documentName || "document"}"`);
  res.send(item.documentData);
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
