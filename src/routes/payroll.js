// src/routes/payroll.js
const express = require("express");
const { prisma, requireAdmin } = require("../middleware/tenant");
const { payPeriodRange, evaluatePayPeriod, grossPay, round2 } = require("../lib/payrollCalc");
const { getValidAccessToken } = require("../lib/quickbooksAuth");
const { pushTimeActivity } = require("../lib/quickbooksClient");
const router = express.Router();

// Payroll — calculating and submitting a run — is admin-only, per the same
// "too consequential for a manager to do unsupervised" call as Facilities
// and QuickBooks. Applies to every route below.
router.use(requireAdmin);

// POST /payroll/runs — build a payroll run from all approved, unpaid shifts in a period
// body: { periodStart: "2026-08-03", periodEnd: "2026-08-16" }
router.post("/runs", async (req, res) => {
  const { periodStart, periodEnd } = req.body;
  if (!periodStart || !periodEnd) {
    return res.status(400).json({ error: "periodStart and periodEnd are required." });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodEnd < periodStart) {
    return res.status(400).json({ error: "Pay period dates must be YYYY-MM-DD, with the end on or after the start." });
  }

  // Stored as the chosen calendar dates (labels). The shifts they cover are
  // picked by payPeriodRange: Pacific time, both dates included.
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  // Any overlap, not just the same start date — otherwise "Sep 1–15" followed
  // by "Sep 10–24" would pay Sep 10–15 twice.
  const overlappingRun = await prisma.payrollRun.findFirst({
    where: { tenantId: req.tenantId, payPeriodStart: { lte: end }, payPeriodEnd: { gte: start } },
    select: { payPeriodStart: true, payPeriodEnd: true },
  });
  if (overlappingRun) {
    const fmt = (d) => d.toISOString().slice(0, 10);
    return res.status(409).json({
      error: `This overlaps an existing payroll run (${fmt(overlappingRun.payPeriodStart)} to ${fmt(overlappingRun.payPeriodEnd)}).`,
    });
  }

  const employees = await prisma.employee.findMany({
    where: { tenantId: req.tenantId, status: "active" },
    include: { home: true },
  });

  const payrollRun = await prisma.payrollRun.create({
    data: {
      tenantId: req.tenantId,
      payPeriodStart: start,
      payPeriodEnd: end,
      status: "calculated",
    },
  });

  let totalGrossPay = 0;
  const lineItems = [];

  for (const employee of employees) {
    const shifts = await prisma.shift.findMany({
      where: {
        tenantId: req.tenantId,
        employeeId: employee.id,
        approved: true,
        clockIn: payPeriodRange(periodStart, periodEnd),
        clockOut: { not: null },
      },
      include: { home: true },
    });
    if (shifts.length === 0) continue;

    const evaluated = evaluatePayPeriod(
      shifts.map((s) => ({
        clockIn: s.clockIn.toISOString(),
        clockOut: s.clockOut.toISOString(),
        shiftType: s.shiftType,
        sleepTimeExcludedMinutes: s.sleepTimeExcludedMinutes,
        sleepInterrupted: s.sleepInterrupted,
      }))
    );

    const pay = grossPay(evaluated, Number(employee.payRate));
    totalGrossPay += pay;

    lineItems.push({
      employeeId: employee.id,
      regularHours: evaluated.regularHours,
      overtimeHours: evaluated.overtimeHours,
      grossPay: pay,
    });
  }

  await prisma.payrollRun.update({
    where: { id: payrollRun.id },
    data: { totalGrossPay: round2(totalGrossPay) },
  });

  await prisma.payrollLineItem.createMany({
    data: lineItems.map((li) => ({ ...li, payrollRunId: payrollRun.id })),
  });

  const full = await prisma.payrollRun.findUnique({
    where: { id: payrollRun.id },
    include: { lineItems: { include: { employee: { select: { name: true } } } } },
  });

  res.status(201).json(full);
});

// PATCH /payroll/runs/:id/submit — pushes hours to QuickBooks as TimeActivity
// records, then marks the run submitted. This is the "Submit in Gusto" button's
// equivalent on the payroll summary screen — human reviews the flags first,
// then this call is what actually sends hours to QuickBooks Payroll.
router.patch("/runs/:id/submit", async (req, res) => {
  const run = await prisma.payrollRun.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
    include: { lineItems: { include: { employee: { include: { home: true } } } } },
  });
  if (!run) return res.status(404).json({ error: "Payroll run not found." });
  if (run.status === "submitted") {
    return res.status(400).json({ error: "This payroll run was already submitted." });
  }

  const getAccessToken = () => getValidAccessToken(req.tenantId);
  const errors = [];

  for (const lineItem of run.lineItems) {
    if (!lineItem.employee.qboEmployeeId) {
      errors.push(`${lineItem.employee.name} has no linked QuickBooks employee — skipped.`);
      continue;
    }
    try {
      if (Number(lineItem.regularHours) > 0) {
        await pushTimeActivity(req.tenant.quickbooksRealmId, getAccessToken, {
          qboEmployeeId: lineItem.employee.qboEmployeeId,
          date: run.payPeriodEnd.toISOString().slice(0, 10),
          hours: Number(lineItem.regularHours),
          payrollItem: "Regular Hours",
          qboLocationId: lineItem.employee.home?.qboLocationId,
        });
      }
      if (Number(lineItem.overtimeHours) > 0) {
        await pushTimeActivity(req.tenant.quickbooksRealmId, getAccessToken, {
          qboEmployeeId: lineItem.employee.qboEmployeeId,
          date: run.payPeriodEnd.toISOString().slice(0, 10),
          hours: Number(lineItem.overtimeHours),
          payrollItem: "Overtime Hours",
          qboLocationId: lineItem.employee.home?.qboLocationId,
        });
      }
    } catch (err) {
      console.error(`QuickBooks time push failed for ${lineItem.employee.name}:`, err);
      errors.push(`${lineItem.employee.name}: push failed, review manually.`);
    }
  }

  const updated = await prisma.payrollRun.update({
    where: { id: run.id },
    data: { status: "submitted" },
  });

  // Errors don't block the response — a partial push still needs the operator
  // to know which employees need manual attention in QuickBooks.
  res.json({ ...updated, warnings: errors });
});

module.exports = router;
