// src/routes/shifts.js
const express = require("express");
const { prisma } = require("../middleware/tenant");
const { evaluateWeeklyHours } = require("../lib/overtimeFlagging");
const router = express.Router();

// POST /shifts/clock-in — start a shift
router.post("/clock-in", async (req, res) => {
  const { employeeId, shiftType } = req.body;
  if (!employeeId || !shiftType) {
    return res.status(400).json({ error: "employeeId and shiftType are required." });
  }

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId: req.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found." });

  const shift = await prisma.shift.create({
    data: {
      tenantId: req.tenantId,
      employeeId,
      clockIn: new Date(),
      shiftType,
    },
  });
  res.status(201).json(shift);
});

// POST /shifts/:id/clock-out — end a shift
router.post("/:id/clock-out", async (req, res) => {
  const { sleepTimeExcludedMinutes, sleepInterrupted } = req.body;

  const shift = await prisma.shift.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!shift) return res.status(404).json({ error: "Shift not found." });
  if (shift.clockOut) return res.status(400).json({ error: "Shift already clocked out." });

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
