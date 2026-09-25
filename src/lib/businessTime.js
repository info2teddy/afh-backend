// src/lib/businessTime.js
// Calendar dates in the businesses' own time zone. Every CareFit Connect
// business is a Washington AFH, so "Sep 15" means Sep 15 in Pacific time —
// not the UTC day, which starts at 5pm Pacific (4pm in winter) the day
// before. Payroll periods and FLSA workweeks both hang off this.

const BUSINESS_TIME_ZONE = "America/Los_Angeles";

const dateKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// "YYYY-MM-DD" of an instant, as a Pacific-time calendar date.
function localDateKey(instant) {
  return dateKeyFormat.format(new Date(instant));
}

// Minutes Pacific time is behind UTC at an instant (420 in summer, 480 in winter).
function offsetMinutes(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIME_ZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(instant)
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((instant.getTime() - asUtc) / 60000);
}

// The instant a Pacific-time calendar date ("YYYY-MM-DD") begins.
function startOfLocalDay(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const first = new Date(guess.getTime() + offsetMinutes(guess) * 60000);
  // Re-check at the candidate itself, in case a DST change falls in between.
  return new Date(guess.getTime() + offsetMinutes(first) * 60000);
}

// "YYYY-MM-DD" plus n calendar days.
function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

module.exports = { BUSINESS_TIME_ZONE, localDateKey, startOfLocalDay, addDays };
