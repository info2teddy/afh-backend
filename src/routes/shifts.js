// src/routes/shifts.js
const express = require("express");
const bcrypt = require("bcryptjs");
const { prisma } = require("../middleware/tenant");
const { evaluateWeeklyHours } = require("../lib/overtimeFlagging");
const router = express.Router();

// GET /shifts/open — currently clocked-in employees, for the kiosk to show
// "clock out" instead of "clock in" per employee.
router.get("/open", async (req, res) => {
  const shifts = await prisma.shift.findMany({
    where: { tenantId: req.tenantId, clockOut: null },
    select: { id: true, employeeId: true, clockIn: true, shiftType: true },
  });
  res.json(shifts);
});

// POST /shifts/clock-in — start a shift. Requires the employee's kiosk PIN,
// since this is meant to be usable from a shared home tablet without a
// manager entering their own login for every caregiver.
router.post("/clock-in", async (req, res) => {
  const { employeeId, shiftType, pin } = req.body;
  if (!employeeId || !shiftType || !pin) {
    return res.status(400).json({ error: "employeeId, shiftType, and pin are required." });
  }

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: req.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found." });
  if (!employee.pinHash) {
    return res.status(400).json({ error: "No PIN set for this employee yet — ask a manager to set one." });
  }
  if (!(await bcrypt.compare(pin, employee.pinHash))) {
    return res.status(401).json({ error: "Incorrect PIN." });
  }

  const alreadyOpen = await prisma.shift.findFirst({
    where: { tenantId: req.tenantId, employeeId, clockOut: null },
  });
  if (alreadyOpen) {
    return res.status(400).json({ error: "Already clocked in." });
  }

  const shift = await prisma.shift.create({
    data: {
      tenantId: req.tenantId,
      employeeId,
      homeId: employee.homeId,
      clockIn: new Date(),
      shiftType,
    },
  });
  res.status(201).json(shift);
});

// POST /shifts/:id/clock-out — end a shift. Also PIN-gated, so one caregiver
// can't clock another one out at a shared kiosk.
router.post("/:id/clock-out", async (req, res) => {
  const { sleepTimeExcludedMinutes, sleepInterrupted, pin } = req.body;
  if (!pin) return res.status(400).json({ error: "pin is required." });

  const shift = await prisma.shift.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
    include: { employee: true },
  });
  if (!shift) return res.status(404).json({ error: "Shift not found." });
  if (shift.clockOut) return res.status(400).json({ error: "Shift already clocked out." });
  if (!(await bcrypt.compare(pin, shift.employee.pinHash || ""))) {
    return res.status(401).json({ error: "Incorrect PIN." });
  }

  const updated = await prisma.shift.update({
    where: { id: shift.id },
    data: {
      clockOut: new Date(),
      sleepTimeExcludedMinutes: sleepTimeExcludedMinutes ?? 0,
      sleepInterrupted: !!sleepInterrupted,
    },
  });
  res.json(updated);
});

// GET /shifts/employees/:employeeId/week?weekStart=2026-08-03
// Returns the evaluated week (regular/OT hours, flags) for the approval screen.
router.get("/employees/:employeeId/week", async (req, res) => {
  const { employeeId } = req.params;
  const weekStart = req.query.weekStart ? new Date(req.query.weekStart) : null;
  if (!weekStart) return res.status(400).json({ error: "weekStart query param is required." });

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: req.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found." });

  const shifts = await prisma.shift.findMany({
    where: {
      tenantId: req.tenantId,
      employeeId,
      clockIn: { gte: weekStart, lt: weekEnd },
      clockOut: { not: null },
    },
    orderBy: { clockIn: "asc" },
  });

  const evaluated = evaluateWeeklyHours(
    shifts.map((s) => ({
      clockIn: s.clockIn.toISOString(),
      clockOut: s.clockOut.toISOString(),
      shiftType: s.shiftType,
      sleepTimeExcludedMinutes: s.sleepTimeExcludedMinutes,
      sleepInterrupted: s.sleepInterrupted,
    }))
  );

  res.json({ employee: { id: employee.id, name: employee.name }, shiftIds: shifts.map((s) => s.id), ...evaluated });
});

// POST /shifts/approve — mark a batch of shifts approved by a manager
router.post("/approve", async (req, res) => {
  const { shiftIds, approvedBy } = req.body;
  if (!Array.isArray(shiftIds) || shiftIds.length === 0 || !approvedBy) {
    return res.status(400).json({ error: "shiftIds (array) and approvedBy are required." });
  }

  const result = await prisma.shift.updateMany({
    where: { id: { in: shiftIds }, tenantId: req.tenantId }, // scoped even for bulk updates
    data: { approved: true, approvedBy, approvedAt: new Date() },
  });

  res.json({ approvedCount: result.count });
});

module.exports = router;
