// src/routes/auth.js
// Runs BEFORE tenant resolution — login itself doesn't have a tenant context
// yet; the tenant comes FROM the successful login instead.

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET; // long random string, never hardcode
const TOKEN_EXPIRY = "12h";

// Brute-force protection: 5 login attempts per 15 minutes per IP. Successful
// logins don't count against the limit, so normal users are unaffected.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
});

router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // Same generic error whether the email doesn't exist or the password is
  // wrong — don't reveal which one, that's an account-enumeration leak.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = jwt.sign(
    { userId: user.id, tenantId: user.tenantId, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { id: true, name: true },
  });

  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId },
    tenant,
  });
});

// POST /auth/switch-tenant — admin-only. Re-issues a JWT scoped to a
// different tenant so an admin can move between the AFH businesses they
// oversee without logging out. Every other route just trusts whatever
// tenantId is in the token, so nothing downstream needs to change.
router.post("/switch-tenant", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }
  let caller;
  try {
    caller = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
  if (caller.role !== "admin") {
    return res.status(403).json({ error: "Only admins can switch between businesses." });
  }

  const { tenantId } = req.body;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
  if (!tenant) {
    return res.status(404).json({ error: "Business not found." });
  }

  const newToken = jwt.sign(
    { userId: caller.userId, tenantId: tenant.id, role: caller.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  res.json({ token: newToken, tenant });
});

// POST /auth/users — create a login for a tenant's staff. Protected: only an
// authenticated admin can call this. The route lives before the tenant
// middleware in app.js, so it does its own token verification here.
router.post("/users", async (req, res) => {
  // Verify the caller is a logged-in admin
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }
  let caller;
  try {
    caller = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
  if (caller.role !== "admin") {
    return res.status(403).json({ error: "Only admins can create user accounts." });
  }

  const { tenantId, email, password, role } = req.body;
  if (!tenantId || !email || !password) {
    return res.status(400).json({ error: "tenantId, email, and password are required." });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "A user with this email already exists." });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { tenantId, email, passwordHash, role: role || "manager" },
  });

  res.status(201).json({ id: user.id, email: user.email, role: user.role });
});

// DELETE /auth/users/:id — admin-only, e.g. removing a leftover demo/seed
// account. Same before-tenant-middleware pattern as the routes above.
router.delete("/users/:id", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }
  let caller;
  try {
    caller = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
  if (caller.role !== "admin") {
    return res.status(403).json({ error: "Only admins can delete user accounts." });
  }
  if (caller.userId === req.params.id) {
    return res.status(400).json({ error: "You can't delete your own account while logged in as it." });
  }

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "User not found." });

  try {
    await prisma.user.delete({ where: { id: user.id } });
  } catch (err) {
    // Foreign-key constraint (e.g. this user authored resident notes) — surface
    // a clear message instead of a raw 500.
    return res.status(409).json({ error: "This account has related records (e.g. notes) and can't be deleted." });
  }
  res.status(204).end();
});

module.exports = router;
