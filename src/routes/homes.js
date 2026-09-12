// src/routes/homes.js
// Homes are the physical AFH properties a tenant operates — most tenants
// have exactly one, but the schema (and this route) supports several, for
// an operator running multiple licensed homes under one business.

const express = require("express");
const { prisma, requireAdmin } = require("../middleware/tenant");
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

router.post("/", requireAdmin, async (req, res) => {
  const { name, licenseNumber, address, capacity } = req.body;
  if (!name || !licenseNumber || !capacity) {
    return res.status(400).json({ error: "name, licenseNumber, and capacity are required." });
  }

  const home = await prisma.home.create({
    data: { tenantId: req.tenantId, name, licenseNumber, address: address || null, capacity: Number(capacity) },
  });
  res.status(201).json(home);
});

router.patch("/:id", requireAdmin, async (req, res) => {
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

// DELETE /homes/:id — only if the home has never had any real activity
// recorded against it. Resident/Employee/Shift/Expense all cascade-delete
// from Home at the DB level, which is fine for a home that's genuinely
// untouched but would silently wipe permanent compliance records (shifts,
// residents) if allowed once any exist — so this checks first rather than
// relying on the cascade.
router.delete("/:id", requireAdmin, async (req, res) => {
  const home = await prisma.home.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
    include: { _count: { select: { residents: true, employees: true, shifts: true, expenses: true, assignments: true } } },
  });
  if (!home) return res.status(404).json({ error: "Home not found." });

  const rateScheduleCount = await prisma.rateSchedule.count({ where: { homeId: home.id } });
  const { residents, employees, shifts, expenses, assignments } = home._count;
  if (residents + employees + shifts + expenses + assignments + rateScheduleCount > 0) {
    return res.status(400).json({ error: "This home has residents, staff, shifts, expenses, or rate schedules recorded against it and can't be deleted." });
  }

  await prisma.$transaction([
    // The lazily-auto-synced PlacementFacility mirror (see placements.js) has
    // no DB-level FK to Home, so it won't cascade on its own — clean it up
    // here. Safe because zero residents (checked above) means it can't have
    // been the destination of a completed placement yet.
    prisma.placementFacility.deleteMany({ where: { homeId: home.id } }),
    prisma.home.delete({ where: { id: home.id } }),
  ]);
  res.status(204).end();
});

module.exports = router;
