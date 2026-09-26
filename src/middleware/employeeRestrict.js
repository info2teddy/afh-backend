// src/middleware/employeeRestrict.js
// A caregiver's own login (role: "employee" — distinct from the shared
// clock-in tablet's "kiosk" role, see kioskRestrict.js) is meant for one
// person on their own device: viewing their assigned residents, logging ADL
// tasks, adding notes, reading the care plan, and clocking themselves in/out.
// It is NOT a lighter-weight manager — no other resident's data, no staff/
// financial data, nothing tenant-wide. Mounted the same way as
// restrictKiosk, right after resolveTenant, so it covers every router
// mounted after it without each one needing its own check.
//
// This only narrows WHICH ROUTES an employee login can call — it does not by
// itself scope WHICH ROWS within an allowed route (e.g. only their assigned
// homes' residents). That scoping happens inside each route itself, via
// lib/employeeScope.js, because "assigned homes" varies per employee and
// can't be expressed as a URL pattern.
const ALLOWED_EMPLOYEE_ROUTES = [
  { method: "GET", pattern: /^\/residents$/ },
  { method: "GET", pattern: /^\/residents\/[^/]+$/ },
  { method: "GET", pattern: /^\/residents\/[^/]+\/photo$/ }, // read-only; home-scoped in the route
  { method: "GET", pattern: /^\/residents\/[^/]+\/notes$/ },
  { method: "POST", pattern: /^\/residents\/[^/]+\/notes$/ },
  { method: "GET", pattern: /^\/residents\/[^/]+\/adl$/ },
  { method: "POST", pattern: /^\/residents\/[^/]+\/adl$/ },
  { method: "DELETE", pattern: /^\/residents\/[^/]+\/adl\/[^/]+$/ },
  { method: "GET", pattern: /^\/residents\/[^/]+\/vitals$/ },
  { method: "POST", pattern: /^\/residents\/[^/]+\/vitals$/ },
  { method: "GET", pattern: /^\/care-plans$/ }, // read-only — POST /care-plans/generate is deliberately absent
  // GET /shifts/open is tenant-wide, not home-scoped, same as the kiosk role
  // already gets (see kioskRestrict.js) — it's just who's currently clocked
  // in, not resident/financial data, so this isn't a new exposure.
  { method: "GET", pattern: /^\/shifts\/open$/ },
  { method: "POST", pattern: /^\/shifts\/clock-in$/ },
  { method: "POST", pattern: /^\/shifts\/[^/]+\/clock-out$/ },
];

function restrictEmployee(req, res, next) {
  if (req.userRole !== "employee") return next();

  const allowed = ALLOWED_EMPLOYEE_ROUTES.some((r) => r.method === req.method && r.pattern.test(req.path));
  if (!allowed) {
    return res.status(403).json({ error: "This login can only view its own assigned residents and log care." });
  }
  next();
}

module.exports = { restrictEmployee };
