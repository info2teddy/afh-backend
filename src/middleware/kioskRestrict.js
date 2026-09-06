// src/middleware/kioskRestrict.js
// A kiosk-role login (see routes/auth.js) is meant to sit on a shared tablet
// doing nothing but clock in/out — so it's restricted here at the API layer,
// not just by hiding nav in the frontend. Even if someone found the token
// and called the API directly (dev tools, curl, a stolen device), a kiosk
// token can't read resident, financial, or payroll data — only the handful
// of routes below. Mounted globally right after resolveTenant, so it covers
// every router mounted after it without each one needing its own check.

const ALLOWED_KIOSK_ROUTES = [
  { method: "GET", pattern: /^\/kiosk\/employees$/ },
  { method: "GET", pattern: /^\/shifts\/open$/ },
  { method: "POST", pattern: /^\/shifts\/clock-in$/ },
  { method: "POST", pattern: /^\/shifts\/[^/]+\/clock-out$/ },
];

function restrictKiosk(req, res, next) {
  if (req.userRole !== "kiosk") return next();

  const allowed = ALLOWED_KIOSK_ROUTES.some((r) => r.method === req.method && r.pattern.test(req.path));
  if (!allowed) {
    return res.status(403).json({ error: "This login can only clock in and out." });
  }
  next();
}

module.exports = { restrictKiosk };
