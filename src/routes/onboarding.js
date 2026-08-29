// src/routes/onboarding.js
const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

// The actual WA AFH new-hire checklist, seeded once per tenant. Conditional
// items (NAR, Dementia/Mental Health/Developmental Disabilities certs) are
// in the library but NOT auto-instantiated for every hire — a manager adds
// them to a specific employee only when they actually apply.
const CHECKLIST_TEMPLATES = [
  { name: "Obtain I.D.", deadlineType: "fixed_days", deadlineDays: 1, sortOrder: 1 },
  { name: "Run background check", deadlineType: "fixed_days", deadlineDays: 1, sortOrder: 2 },
  { name: "Schedule fingerprint", deadlineType: "fixed_days", deadlineDays: null, dependsOnName: "Run background check", sortOrder: 3 },
  { name: "TB testing to start", deadlineType: "fixed_days", deadlineDays: 3, sortOrder: 4 },
  { name: "Orientation and Safety Certificate (5-hour)", deadlineType: "gate", gateName: "before_providing_care", sortOrder: 5 },
  { name: "Facility Orientation", deadlineType: "gate", gateName: "before_routine_interaction", sortOrder: 6 },
  { name: "Background check (satisfactory result)", deadlineType: "gate", gateName: "before_unsupervised_care", sortOrder: 7 },
  { name: "CPR and First Aid card (hands-on only)", deadlineType: "gate", gateName: "before_unsupervised_care", sortOrder: 8 },
  { name: "75-hour Basic Training Certificate", deadlineType: "fixed_days", deadlineDays: 120, sortOrder: 9 },
  { name: "NAR application", deadlineType: "conditional", isConditional: true, sortOrder: 10 },
  { name: "HCA application", deadlineType: "fixed_days", deadlineDays: 14, sortOrder: 11 },
  { name: "Food Worker Card or Food Handling CE", deadlineType: "fixed_days", deadlineDays: 14, sortOrder: 12 },
  { name: "Dementia Certificate", deadlineType: "conditional", isConditional: true, deadlineDays: 90, sortOrder: 13 },
  { name: "Mental Health Certificate", deadlineType: "conditional", isConditional: true, deadlineDays: 90, sortOrder: 14 },
  { name: "Developmental Disabilities Certificate", deadlineType: "conditional", isConditional: true, deadlineDays: 90, sortOrder: 15 },
  { name: "Fingerprint Report (satisfactory result)", deadlineType: "fixed_days", deadlineDays: 120, sortOrder: 16 },
  { name: "HCA Certificate", deadlineType: "fixed_days", deadlineDays: 200, sortOrder: 17 },
];

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// POST /onboarding/seed-templates — run once per tenant (or re-run safely;
// it's idempotent by name) to set up the requirement library.
router.post("/seed-templates", async (req, res) => {
  const existing = await prisma.onboardingRequirementTemplate.findMany({
    where: { tenantId: req.tenantId },
  });
  if (existing.length > 0) {
    return res.status(409).json({ error: "Templates already seeded for this tenant.", count: existing.length });
  }

  const idsByName = {};
  // Insert non-dependent templates first, then dependent ones, so dependsOnId can resolve
  const withoutDeps = CHECKLIST_TEMPLATES.filter((t) => !t.dependsOnName);
  const withDeps = CHECKLIST_TEMPLATES.filter((t) => t.dependsOnName);

  for (const t of withoutDeps) {
    const created = await prisma.onboardingRequirementTemplate.create({
      data: {
        tenantId: req.tenantId,
        name: t.name,
        deadlineType: t.deadlineType,
        deadlineDays: t.deadlineDays ?? null,
        gateName: t.gateName ?? null,
        isConditional: !!t.isConditional,
        sortOrder: t.sortOrder,
      },
    });
    idsByName[t.name] = created.id;
  }
  for (const t of withDeps) {
    const created = await prisma.onboardingRequirementTemplate.create({
      data: {
        tenantId: req.tenantId,
        name: t.name,
        deadlineType: t.deadlineType,
        deadlineDays: t.deadlineDays ?? null,
        dependsOnId: idsByName[t.dependsOnName],
        sortOrder: t.sortOrder,
      },
    });
    idsByName[t.name] = created.id;
  }

  res.status(201).json({ seeded: Object.keys(idsByName).length });
});

// POST /employees/:employeeId/onboarding/instantiate — run once when an
// employee is hired. Only non-conditional requirements are auto-created.
router.post("/employees/:employeeId/instantiate", async (req, res) => {
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.employeeId, tenantId: req.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found." });

  const templates = await prisma.onboardingRequirementTemplate.findMany({
    where: { tenantId: req.tenantId, isConditional: false },
  });
  if (templates.length === 0) {
    return res.status(400).json({ error: "No requirement templates seeded yet — call /onboarding/seed-templates first." });
  }

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
      status,
    };
  });

  res.json(withStatus);
});

// PATCH /onboarding/:itemId/complete
router.patch("/:itemId/complete", async (req, res) => {
  const item = await prisma.employeeOnboardingItem.findFirst({
    where: { id: req.params.itemId, tenantId: req.tenantId },
    include: { template: true },
  });
  if (!item) return res.status(404).json({ error: "Onboarding item not found." });

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

module.exports = router;
