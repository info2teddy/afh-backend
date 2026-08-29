// src/middleware/tenant.js
//
// Every request must resolve to exactly one tenant before touching the database.
// This now comes from a verified JWT (issued at /auth/login), not a trusted
// header — a header is trivially spoofable by anyone, a signed token isn't.

const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

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
  next();
}

module.exports = { resolveTenant, prisma };
