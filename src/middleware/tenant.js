// src/middleware/tenant.js
//
// Every request must resolve to exactly one tenant before touching the database.
// This now comes from a verified JWT (issued at /auth/login), not a trusted
// header — a header is trivially spoofable by anyone, a signed token isn't.

const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
// The SSN column is omitted from every query on this client — including nested
// includes — so no route can leak it by returning a Resident row. The two places
// that legitimately need it (the reveal endpoint and the startup migration in
// lib/ssn.js) opt back in by naming the column in an explicit `select`.
const prisma = new PrismaClient({ omit: { resident: { socialSecurityNumber: true } } });

const JWT_SECRET = process.env.JWT_SECRET;

async function resolveTenant(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header." });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session — log in again." });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: payload.tenantId } });
  if (!tenant) {
    return res.status(404).json({ error: "Tenant not found." });
  }

  req.tenantId = tenant.id;
  req.tenant = tenant;
  req.userId = payload.userId;
  req.userRole = payload.role;
  // Only present on an employee-role token (see routes/auth.js login) — the
  // roster Employee row this login acts as. Routes that reach an employee
  // login use this with lib/employeeScope.js to filter to that person's
  // assigned homes; every other role leaves this undefined.
  req.employeeId = payload.employeeId || null;
  next();
}

// For routes an AFH owner/manager shouldn't touch at all — business setup
// (Facilities) and the QuickBooks integration, both flagged by the user as
// too technical/risky for a manager to configure themselves. Mounted per
// route or per router, same pattern as restrictKiosk.
function requireAdmin(req, res, next) {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "This action is restricted to CareFit administrators." });
  }
  next();
}

module.exports = { resolveTenant, requireAdmin, prisma };
