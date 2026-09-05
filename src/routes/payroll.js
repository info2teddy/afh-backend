// src/routes/payroll.js
const express = require("express");
const { prisma } = require("../middleware/tenant");
const { evaluateWeeklyHours } = require("../lib/overtimeFlagging");
const { getValidAccessToken } = require("../lib/quickbooksAuth");
const { pushTimeActivity } = require("../lib/quickbooksClient");
const router = express.Router();

// FLSA overtime is calculated per WORKWEEK, not per pay period — a biweekly
// or semi-monthly payroll run must evaluate each Mon-Sun week separately and
// sum the results, or overtime gets badly overstated for anyone whose hours
// vary between weeks (confirmed by test-payroll.js: a 30hr/45hr split across
// two weeks was reported as 35 OT hours instead of the correct 5).
function groupShiftsByWorkweek(shifts) {
  const weeks = new Map();
  for (const shift of shifts) {
    const clockIn = new Date(shift.clockIn);
    const day = clockIn.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(clockIn);
    monday.setUTCDate(monday.getUTCDate() + mondayOffset);
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.toISOString().slice(0, 10);

    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(shift);
  }
  return [...weeks.values()];
}

function evaluatePayPeriod(shifts) {
  const weeklyGroups = groupShiftsByWorkweek(shifts);
  let regularHours = 0;
  let overtimeHours = 0;
  const flags = [];
  const shiftBreakdown = [];

  for (const weekShifts of weeklyGroups) {
    const result = evaluateWeeklyHours(weekShifts);
    regularHours += result.regularHours;
    overtimeHours += result.overtimeHours;
    flags.push(...result.flags);
    shiftBreakdown.push(...result.shiftBreakdown);
  }

  return {
    regularHours: round2(regularHours),
    overtimeHours: round2(overtimeHours),
    flags,
    shiftBreakdown,
  };
}

// POST /payroll/runs — build a payroll run from all approved, unpaid shifts in a period
// body: { periodStart: "2026-08-03", periodEnd: "2026-08-16" }
router.post("/runs", async (req, res) => {
  const { periodStart, periodEnd } = req.body;
  if (!periodStart || !periodEnd) {
    return res.status(400).json({ error: "periodStart and periodEnd are required." });
  }

  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  const existingRun = await prisma.payrollRun.findFirst({
    where: { tenantId: req.tenantId, payPeriodStart: start },
  });
  if (existingRun) {
    return res.status(409).json({ error: "A payroll run already exists for this pay period." });
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
        clockIn: { gte: start, lt: end },
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

    const hourlyRate = Number(employee.payRate);
    const grossPay = round2(
      evaluated.regularHours * hourlyRate + evaluated.overtimeHours * hourlyRate * 1.5
    );
    totalGrossPay += grossPay;

    lineItems.push({
      employeeId: employee.id,
      regularHours: evaluated.regularHours,
      overtimeHours: evaluated.overtimeHours,
      grossPay,
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = router;
