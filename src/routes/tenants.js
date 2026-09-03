// src/routes/tenants.js
// Cross-tenant admin console: list/create AFH businesses. Runs BEFORE tenant
// resolution — an admin browsing across tenants has no single tenant context
// yet, so these routes verify the caller themselves instead of relying on
// resolveTenant (which assumes exactly one tenant per request).

const express = require("express");
const jwt = require("jsonwebtoken");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
  if (payload.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  req.userId = payload.userId;
  next();
}

router.use(requireAdmin);

// GET /tenants — every AFH business, for the admin's tenant switcher.
router.get("/", async (req, res) => {
  const tenants = await prisma.tenant.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, createdAt: true, _count: { select: { residents: true, employees: true } } },
  });
  res.json(tenants);
});

// POST /tenants — onboard a new AFH business.
router.post("/", async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "A business name is required." });
  }
  const tenant = await prisma.tenant.create({ data: { name: name.trim() } });
  res.status(201).json(tenant);
});

module.exports = router;
