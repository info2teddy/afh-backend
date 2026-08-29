// src/lib/overtimeFlagging.js
// Same logic as the standalone overtime_flagging.js script, adapted as a module
// import for use inside route handlers.

const WEEKLY_OT_THRESHOLD_HOURS = 40;
const NEAR_OT_WARNING_HOURS = 36;

function evaluateWeeklyHours(shifts) {
  let paidMinutes = 0;
  const shiftBreakdown = [];

  for (const shift of shifts) {
    const start = new Date(shift.clockIn);
    const end = new Date(shift.clockOut);
    const workedMinutes = (end - start) / 60000;

    let excludedMinutes = shift.sleepTimeExcludedMinutes || 0;
    if (shift.sleepInterrupted) excludedMinutes = 0;

    const paidForShift = Math.max(workedMinutes - excludedMinutes, 0);
    paidMinutes += paidForShift;

    shiftBreakdown.push({
      date: shift.clockIn.slice(0, 10),
      shiftType: shift.shiftType,
      workedHours: round2(workedMinutes / 60),
      paidHours: round2(paidForShift / 60),
      sleepExcluded: excludedMinutes > 0,
      flaggedInterrupted: !!shift.sleepInterrupted,
    });
  }

  const totalPaidHours = round2(paidMinutes / 60);
  const overtimeHours = Math.max(totalPaidHours - WEEKLY_OT_THRESHOLD_HOURS, 0);

  return {
    totalPaidHours,
    regularHours: round2(Math.min(totalPaidHours, WEEKLY_OT_THRESHOLD_HOURS)),
    overtimeHours: round2(overtimeHours),
    shiftBreakdown,
    flags: buildFlags(totalPaidHours, shiftBreakdown),
  };
}

function buildFlags(totalPaidHours, shiftBreakdown) {
  const flags = [];

  if (totalPaidHours > WEEKLY_OT_THRESHOLD_HOURS) {
    flags.push({
      level: "overtime",
      message: `${round2(totalPaidHours - WEEKLY_OT_THRESHOLD_HOURS)} hours over the 40-hour threshold this week.`,
    });
  } else if (totalPaidHours >= NEAR_OT_WARNING_HOURS && totalPaidHours < WEEKLY_OT_THRESHOLD_HOURS) {
    flags.push({
      level: "warning",
      message: `Approaching overtime — ${round2(WEEKLY_OT_THRESHOLD_HOURS - totalPaidHours)} hours left before OT kicks in.`,
    });
  }

  const interruptedShifts = shiftBreakdown.filter((s) => s.flaggedInterrupted);
  if (interruptedShifts.length > 0) {
    flags.push({
      level: "warning",
      message: `${interruptedShifts.length} shift(s) had interrupted sleep time — excluded hours were paid instead.`,
    });
  }

  return flags;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { evaluateWeeklyHours };
