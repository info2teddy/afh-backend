// src/lib/fireDrills.js
// Shared between routes/homes.js (GET /homes/fire-drill-status, the
// Compliance page's own view) and routes/alerts.js (the Dashboard's
// cross-cutting alerts) so the two never drift on what counts as overdue.
const FIRE_DRILL_INTERVAL_DAYS = 60; // the compliance cadence CareFit tracks against
const FIRE_DRILL_DUE_SOON_DAYS = 14; // matches Credentials' warning-vs-danger banding

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// homes: [{ id, name }], latestByHome: { [homeId]: Date | null }
// A home with no drill ever logged is overdue from day one, not "unknown" —
// there's no grace period for a home that's never actually run a drill.
function computeFireDrillStatus(homes, latestByHome, today = new Date()) {
  return homes.map((home) => {
    const last = latestByHome[home.id] || null;
    const dueAt = last ? addDays(last, FIRE_DRILL_INTERVAL_DAYS) : null;
    const status = !last || dueAt < today ? "overdue" : dueAt < addDays(today, FIRE_DRILL_DUE_SOON_DAYS) ? "due_soon" : "ok";
    return { homeId: home.id, homeName: home.name, lastDrilledAt: last, dueAt, status };
  });
}

module.exports = { FIRE_DRILL_INTERVAL_DAYS, FIRE_DRILL_DUE_SOON_DAYS, computeFireDrillStatus };
