// Pay math: pay-period boundaries, FLSA workweeks, overtime, gross pay.
// Run with `npm test`. No database needed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { payPeriodRange, workweekKey, evaluatePayPeriod, grossPay } = require("../src/lib/payrollCalc");

// A shift from local Pacific wall-clock times, e.g. shift("2026-09-14T09:00", "2026-09-14T17:00").
// September is PDT (UTC-7); January is PST (UTC-8).
function pt(local) {
  const offset = /^\d{4}-(0[4-9]|10)/.test(local) ? "-07:00" : "-08:00"; // good enough for the dates used here
  return new Date(local + ":00" + offset).toISOString();
}
const shift = (inLocal, outLocal, extra = {}) => ({ clockIn: pt(inLocal), clockOut: pt(outLocal), shiftType: "day", ...extra });
const inPeriod = (range, s) => new Date(s.clockIn) >= range.gte && new Date(s.clockIn) < range.lt;

test("pay period includes its last day, in Pacific time", () => {
  const range = payPeriodRange("2026-09-01", "2026-09-15");
  assert.equal(range.gte.toISOString(), "2026-09-01T07:00:00.000Z");
  assert.equal(range.lt.toISOString(), "2026-09-16T07:00:00.000Z");
  assert.ok(inPeriod(range, shift("2026-09-15T08:00", "2026-09-15T16:00")), "a shift on the 15th is paid in the 1st–15th run");
  assert.ok(inPeriod(range, shift("2026-09-14T19:00", "2026-09-14T23:00")), "an evening shift on the 14th is paid too");
});

test("back-to-back pay periods leave no gap and no overlap", () => {
  const first = payPeriodRange("2026-09-01", "2026-09-15");
  const second = payPeriodRange("2026-09-16", "2026-09-30");
  assert.equal(first.lt.getTime(), second.gte.getTime());
  for (const s of [shift("2026-09-15T23:30", "2026-09-16T07:30"), shift("2026-09-16T00:00", "2026-09-16T08:00"), shift("2026-09-15T12:00", "2026-09-15T20:00")]) {
    assert.equal([first, second].filter((r) => inPeriod(r, s)).length, 1, `${s.clockIn} lands in exactly one run`);
  }
});

test("pay period boundaries follow daylight saving time", () => {
  const winter = payPeriodRange("2026-01-01", "2026-01-15");
  assert.equal(winter.gte.toISOString(), "2026-01-01T08:00:00.000Z");
  // Clocks fall back on Nov 1, 2026: the period starts on PDT, ends on PST.
  const fallBack = payPeriodRange("2026-10-26", "2026-11-08");
  assert.equal(fallBack.gte.toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(fallBack.lt.toISOString(), "2026-11-09T08:00:00.000Z");
});

test("workweek is Monday–Sunday in Pacific time", () => {
  assert.equal(workweekKey(pt("2026-09-14T00:30")), "2026-09-14", "just after midnight Monday");
  assert.equal(workweekKey(pt("2026-09-20T20:00")), "2026-09-14", "Sunday 8pm is still the same week");
  assert.equal(workweekKey(pt("2026-09-21T00:00")), "2026-09-21", "Monday midnight starts the next week");
});

test("overtime is per workweek, not per pay period (30h + 45h = 5h OT, not 35h)", () => {
  const shifts = [];
  for (const d of ["14", "15", "16"]) shifts.push(shift(`2026-09-${d}T08:00`, `2026-09-${d}T18:00`)); // 30h, week 1
  for (const d of ["21", "22", "23", "24", "25"]) shifts.push(shift(`2026-09-${d}T08:00`, `2026-09-${d}T17:00`)); // 45h, week 2
  const r = evaluatePayPeriod(shifts);
  assert.equal(r.regularHours, 70);
  assert.equal(r.overtimeHours, 5);
});

test("a Sunday shift starting after 5pm counts toward the week it was worked", () => {
  // 36h Mon–Thu, then 6h starting 6pm Sunday: 42h in one week, so 2h overtime.
  // Under the old UTC weeks, 6pm Sunday Pacific was already Monday, so the
  // shift moved to the next week and the overtime was lost.
  const shifts = ["14", "15", "16", "17"].map((d) => shift(`2026-09-${d}T08:00`, `2026-09-${d}T17:00`));
  shifts.push(shift("2026-09-20T18:00", "2026-09-21T00:00"));
  const r = evaluatePayPeriod(shifts);
  assert.equal(r.overtimeHours, 2);
});

test("sleep time is excluded unless the sleep was interrupted", () => {
  const night = { shiftType: "overnight", sleepTimeExcludedMinutes: 480 };
  const quiet = evaluatePayPeriod([shift("2026-09-14T20:00", "2026-09-15T08:00", night)]);
  assert.equal(quiet.regularHours, 4);
  const interrupted = evaluatePayPeriod([shift("2026-09-14T20:00", "2026-09-15T08:00", { ...night, sleepInterrupted: true })]);
  assert.equal(interrupted.regularHours, 12, "interrupted sleep is paid in full");
  assert.ok(interrupted.flags.some((f) => /interrupted sleep/.test(f.message)));
});

test("gross pay is time-and-a-half for overtime, to the cent", () => {
  assert.equal(grossPay({ regularHours: 40, overtimeHours: 5 }, 21.5), 1021.25);
  assert.equal(grossPay({ regularHours: 33.33, overtimeHours: 0 }, 19.99), 666.27);
  assert.equal(grossPay({ regularHours: 0, overtimeHours: 0 }, 25), 0);
});
