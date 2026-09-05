// src/routes/residents.js
// Every query includes tenantId in the where clause — no exceptions. This is
// the pattern every other route file (employees, invoices, shifts) follows.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

// GET /residents — list all residents for the current tenant
router.get("/", async (req, res) => {
  const residents = await prisma.resident.findMany({
    where: { tenantId: req.tenantId }, // never omit this
    orderBy: { name: "asc" },
  });
  res.json(residents);
});

// GET /residents/:id — a single resident, still scoped to tenant
router.get("/:id", async (req, res) => {
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId }, // findFirst, not findUnique —
    // findUnique by id alone would let a request from Tenant A fetch Tenant B's
    // resident just by guessing a UUID. findFirst with both conditions closes that gap.
  });

  if (!resident) {
    return res.status(404).json({ error: "Resident not found." });
  }
  res.json(resident);
});

// POST /residents — create a resident under the current tenant
router.post("/", async (req, res) => {
  const {
    homeId,
    name,
    careLevel,
    payerType,
    medicaidSplitPct,
    moveInDate,
    dateOfBirth,
    room,
    nextAssessmentDate,
    authorizationStatus,
  } = req.body;

  if (!homeId || !name || !careLevel || !payerType || !moveInDate) {
    return res.status(400).json({ error: "Missing required resident fields." });
  }

  // Confirm the home belongs to this tenant before attaching the resident to it —
  // otherwise a request could attach a resident to another tenant's home.
  const home = await prisma.home.findFirst({
    where: { id: homeId, tenantId: req.tenantId },
  });
  if (!home) {
    return res.status(404).json({ error: "Home not found for this tenant." });
  }

  const resident = await prisma.resident.create({
    data: {
      tenantId: req.tenantId,
      homeId,
      name,
      careLevel,
      payerType,
      medicaidSplitPct: medicaidSplitPct ?? null,
      moveInDate: new Date(moveInDate),
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      room: room || null,
      nextAssessmentDate: nextAssessmentDate ? new Date(nextAssessmentDate) : null,
      authorizationStatus: authorizationStatus || null,
    },
  });

  res.status(201).json(resident);
});

// PATCH /residents/:id/link-quickbooks — link this resident to an existing
// QuickBooks Customer, done once during onboarding or when a resident moves in.
router.patch("/:id/link-quickbooks", async (req, res) => {
  const { qboCustomerId } = req.body;
  if (!qboCustomerId) return res.status(400).json({ error: "qboCustomerId is required." });

  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const updated = await prisma.resident.update({
    where: { id: resident.id },
    data: { qboCustomerId },
  });
  res.json(updated);
});

module.exports = router;
