// src/routes/employees.js
const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

// GET /employees — list all employees for the current tenant, with credentials
router.get("/", async (req, res) => {
  const employees = await prisma.employee.findMany({
    where: { tenantId: req.tenantId },
    include: { credentials: true },
    orderBy: { name: "asc" },
  });
  res.json(employees);
});

router.get("/:id", async (req, res) => {
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
    include: { credentials: true },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found." });
  res.json(employee);
});

router.post("/", async (req, res) => {
  const { homeId, name, role, hireDate, payRate, employmentType, liveIn } = req.body;

  if (!homeId || !name || !role || !hireDate || payRate == null || !employmentType) {
    return res.status(400).json({ error: "Missing required employee fields." });
  }

  const home = await prisma.home.findFirst({ where: { id: homeId, tenantId: req.tenantId } });
  if (!home) return res.status(404).json({ error: "Home not found for this tenant." });

  const employee = await prisma.employee.create({
    data: {
      tenantId: req.tenantId,
      homeId,
      name,
      role,
      hireDate: new Date(hireDate),
      payRate,
      employmentType,
      liveIn: !!liveIn,
    },
  });
  res.status(201).json(employee);
});

// GET /employees/credentials/expiring?days=60 — credentials expiring within N days,
// across the whole tenant. Powers the credentials dashboard's alert view.
router.get("/credentials/expiring", async (req, res) => {
  const days = parseInt(req.query.days, 10) || 60;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);

  const credentials = await prisma.credential.findMany({
    where: {
      tenantId: req.tenantId,
      expirationDate: { lte: cutoff },
    },
    include: { employee: { select: { id: true, name: true, role: true } } },
    orderBy: { expirationDate: "asc" },
  });
  res.json(credentials);
});

// POST /employees/:id/credentials — add a credential for an employee
router.post("/:id/credentials", async (req, res) => {
  const { credentialType, issueDate, expirationDate } = req.body;

  if (!credentialType || !issueDate || !expirationDate) {
    return res.status(400).json({ error: "Missing required credential fields." });
  }

  const employee = await prisma.employee.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found." });

  const credential = await prisma.credential.create({
    data: {
      tenantId: req.tenantId,
      employeeId: employee.id,
      credentialType,
      issueDate: new Date(issueDate),
      expirationDate: new Date(expirationDate),
    },
  });
  res.status(201).json(credential);
});

// PATCH /employees/:id/link-quickbooks — link this employee to an existing
// QuickBooks Employee record, done once during onboarding.
router.patch("/:id/link-quickbooks", async (req, res) => {
  const { qboEmployeeId } = req.body;
  if (!qboEmployeeId) return res.status(400).json({ error: "qboEmployeeId is required." });

  const employee = await prisma.employee.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found." });

  const updated = await prisma.employee.update({
    where: { id: employee.id },
    data: { qboEmployeeId },
  });
  res.json(updated);
});

module.exports = router;
