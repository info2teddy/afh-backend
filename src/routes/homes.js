// src/routes/homes.js
// Homes are the physical AFH properties a tenant operates — most tenants
// have exactly one, but the schema (and this route) supports several, for
// an operator running multiple licensed homes under one business.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

router.get("/", async (req, res) => {
  const homes = await prisma.home.findMany({
    where: { tenantId: req.tenantId },
    select: {
      id: true,
      name: true,
      licenseNumber: true,
      address: true,
      capacity: true,
      _count: { select: { residents: true } },
    },
    orderBy: { name: "asc" },
  });
  res.json(homes);
});

router.post("/", async (req, res) => {
  const { name, licenseNumber, address, capacity } = req.body;
  if (!name || !licenseNumber || !capacity) {
    return res.status(400).json({ error: "name, licenseNumber, and capacity are required." });
  }

  const home = await prisma.home.create({
    data: { tenantId: req.tenantId, name, licenseNumber, address: address || null, capacity: Number(capacity) },
  });
  res.status(201).json(home);
});

router.patch("/:id", async (req, res) => {
  const home = await prisma.home.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!home) return res.status(404).json({ error: "Home not found." });

  const { name, licenseNumber, address, capacity } = req.body;
  const updated = await prisma.home.update({
    where: { id: home.id },
    data: {
      ...(name !== undefined && { name }),
      ...(licenseNumber !== undefined && { licenseNumber }),
      ...(address !== undefined && { address: address || null }),
      ...(capacity !== undefined && { capacity: Number(capacity) }),
    },
  });
  res.json(updated);
});

module.exports = router;
