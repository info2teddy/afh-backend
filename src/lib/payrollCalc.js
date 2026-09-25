// src/lib/payrollCalc.js
// The pay math behind POST /payroll/runs, kept free of the database so it can
// be tested directly (test/payrollCalc.test.js).

const { evaluateWeeklyHours } = require("./overtimeFlagging");
const { localDateKey, startOfLocalDay, addDays } = require("./businessTime");

const OVERTIME_MULTIPLIER = 1.5;

// The instants a pay period covers. Both dates are Pacific calendar dates and
// both are INCLUDED — "Sep 1 to Sep 15" runs from Sep 1 00:00 up to (not
// including) Sep 16 00:00 Pacific, so back-to-back periods meet exactly and
// every shift lands in one.
function payPeriodRange(periodStart, periodEnd) {
  return { gte: startOfLocalDay(periodStart), lt: startOfLocalDay(addDays(periodEnd, 1)) };
}

// FLSA overtime is per WORKWEEK, not per pay period — a biweekly run must
// evaluate each week separately and sum, or a 30hr/45hr split across two
// weeks gets reported as 35 OT hours instead of 5. The workweek is Monday
// 00:00 to Sunday 24:00 Pacific, the same weeks the Timekeeping page shows.
// A shift counts toward the week it started in.
function workweekKey(clockIn) {
  const key = localDateKey(clockIn);
  const [y, m, d] = key.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // weekday of that calendar date
  return addDays(key, day === 0 ? -6 : 1 - day);
}

function groupShiftsByWorkweek(shifts) {
  const weeks = new Map();
  for (const shift of shifts) {
    const key = workweekKey(shift.clockIn);
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(shift);
  }
  return [...weeks.values()];
}

function evaluatePayPeriod(shifts) {
  let regularHours = 0;
  let overtimeHours = 0;
  const flags = [];
  const shiftBreakdown = [];

  for (const weekShifts of groupShiftsByWorkweek(shifts)) {
    const result = evaluateWeeklyHours(weekShifts);
    regularHours += result.regularHours;
    overtimeHours += result.overtimeHours;
    flags.push(...result.flags);
    shiftBreakdown.push(...result.shiftBreakdown);
  }

  return { regularHours: round2(regularHours), overtimeHours: round2(overtimeHours), flags, shiftBreakdown };
}

function grossPay({ regularHours, overtimeHours }, hourlyRate) {
  return round2(regularHours * hourlyRate + overtimeHours * hourlyRate * OVERTIME_MULTIPLIER);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { payPeriodRange, workweekKey, groupShiftsByWorkweek, evaluatePayPeriod, grossPay, round2 };
