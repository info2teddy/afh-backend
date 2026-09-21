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
// A kiosk login is meant to sit logged into a shared tablet indefinitely —
// forcing daily re-login defeats the point. It's safe to leave long-lived
// because kioskRestrict.js caps what that token can ever do, regardless of
// how long it's valid for.
const KIOSK_TOKEN_EXPIRY = "90d";

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

  // Case-insensitive and whitespace-tolerant: phone keyboards capitalise the
  // first letter and autofill often appends a space, and an exact match
  // turned each of those into a wrong-password attempt that counted toward the
  // 5-per-15-minutes lockout. The password itself is never altered.
  const user = await prisma.user.findFirst({
    where: { email: { equals: String(email).trim(), mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
  });
  // Same generic error whether the email doesn't exist or the password is
  // wrong — don't reveal which one, that's an account-enumeration leak.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = jwt.sign(
    { userId: user.id, tenantId: user.tenantId, role: user.role },
    JWT_SECRET,
    { expiresIn: user.role === "kiosk" ? KIOSK_TOKEN_EXPIRY : TOKEN_EXPIRY }
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

// Shared by the three routes below, which all run before resolveTenant (an
// admin browsing/managing other tenants has no single tenant context) and so
// verify the caller's JWT themselves. Returns null and has already sent a
// 401/403 response if verification fails.
//
// User/login management (team invites, kiosk logins) used to be self-serve
// for a manager too, but that's admin-only now — same call as Facilities,
// QuickBooks, and Payroll: too consequential for an AFH owner to do
// unsupervised.
function verifyAdminCaller(req, res) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return null;
  }
  let caller;
  try {
    caller = jwt.verify(token, JWT_SECRET);
  } catch {
    res.status(401).json({ error: "Invalid or expired session." });
    return null;
  }
  if (caller.role !== "admin") {
    res.status(403).json({ error: "This action is restricted to CareFit administrators." });
    return null;
  }
  return caller;
}

// PATCH /auth/change-password — any authenticated role (admin, manager,
// kiosk) can change its own login's password; requires the current one, same
// as login itself, since this isn't an admin-reset — it's the account owner
// acting on their own account. No forgot-password/reset-link flow exists
// yet (no email sending anywhere in this app) — that's a separate feature.
router.patch("/change-password", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required." });
  let caller;
  try {
    caller = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword are required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }

  const user = await prisma.user.findUnique({ where: { id: caller.userId } });
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  res.status(204).end();
});

// GET /auth/users?tenantId=... — list logins for a tenant.
router.get("/users", async (req, res) => {
  const caller = verifyAdminCaller(req, res);
  if (!caller) return;

  const tenantId = req.query.tenantId || caller.tenantId;
  const users = await prisma.user.findMany({
    where: { tenantId },
    select: { id: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(users);
});

// POST /auth/users — create a login, for any tenant and any role (this is
// how CareFit itself provisions a new client's very first login too).
router.post("/users", async (req, res) => {
  const caller = verifyAdminCaller(req, res);
  if (!caller) return;

  const { email, password, tenantId, role } = req.body;

  if (!tenantId || !email || !password) {
    return res.status(400).json({ error: "tenantId, email, and password are required." });
  }

  // Stored trimmed and lower-cased so it matches however it's typed at login
  // (login is case-insensitive too, which also covers older mixed-case rows).
  const cleanEmail = String(email).trim().toLowerCase();
  const existing = await prisma.user.findFirst({ where: { email: { equals: cleanEmail, mode: "insensitive" } } });
  if (existing) return res.status(409).json({ error: "A user with this email already exists." });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { tenantId, email: cleanEmail, passwordHash, role: role || "manager" },
  });

  res.status(201).json({ id: user.id, email: user.email, role: user.role });
});

// DELETE /auth/users/:id
router.delete("/users/:id", async (req, res) => {
  const caller = verifyAdminCaller(req, res);
  if (!caller) return;
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
