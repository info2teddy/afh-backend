// src/routes/publicIntake.js
// The one genuinely public (no login) route in the whole app — lets an
// outside AFH (not a CareFit Connect customer) submit itself into the
// Placement facility book directly, instead of CareFit staff re-typing a
// PDF/email intake form by hand. Mounted BEFORE resolveTenant in app.js,
// same as /auth and /tenants, since there's no tenant or user to resolve.
//
// Every submission lands with submittedByFacility: true and reviewedAt:
// null — see placements.js's GET /facilities (pendingReview flag) and the
// guard in POST /inquiries/:id/place — nobody gets placed at a
// self-submitted facility until an admin has actually reviewed it.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

router.post("/afh-intake", async (req, res) => {
  const {
    name,
    address,
    contactName,
    contactPhone,
    contactEmail,
    capacity,
    currentResidents,
    licenseNumber,
    licenseExpiryDate,
    genderAccepted,
    careLevelsAccepted,
    specialtyCare,
    culturalNotes,
    acceptsMedicaid,
    medicaidManagedCareOrgs,
    privateRoomPricing,
    sharedRoomPricing,
    okToShareWithFamilies,
    notes,
  } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: "Facility name is required." });
  if (!contactPhone?.trim() && !contactEmail?.trim()) {
    return res.status(400).json({ error: "A phone number or email is required so we can follow up." });
  }

  const facility = await prisma.placementFacility.create({
    data: {
      name: name.trim(),
      address: address || null,
      contactName: contactName || null,
      contactPhone: contactPhone || null,
      contactEmail: contactEmail || null,
      capacity: capacity != null && capacity !== "" ? Number(capacity) : null,
      currentResidents: currentResidents != null && currentResidents !== "" ? Number(currentResidents) : null,
      licenseNumber: licenseNumber || null,
      licenseExpiryDate: licenseExpiryDate ? new Date(licenseExpiryDate) : null,
      genderAccepted: genderAccepted || null,
      careLevelsAccepted: careLevelsAccepted || null,
      specialtyCare: specialtyCare || null,
      culturalNotes: culturalNotes || null,
      acceptsMedicaid: acceptsMedicaid === true || acceptsMedicaid === "true",
      medicaidManagedCareOrgs: medicaidManagedCareOrgs || null,
      privateRoomPricing: privateRoomPricing || null,
      sharedRoomPricing: sharedRoomPricing || null,
      okToShareWithFamilies: okToShareWithFamilies === true || okToShareWithFamilies === "true",
      notes: notes || null,
      submittedByFacility: true,
    },
    select: { id: true, name: true },
  });

  res.status(201).json({ ok: true, name: facility.name });
});

// GET /placement-review/:token — the family-facing Family Review link (see
// placements.js's POST/DELETE .../share). Deliberately NOT a full public
// page: the token is opaque/unguessable, expires after 30 days, and staff
// can revoke it anytime — this is the only way in, there's no listing route.
// Only shows shortlisted facilities that have explicitly consented to
// family sharing (okToShareWithFamilies) and only family-safe fields — no
// internal staff notes, no match scores/criteria.
router.get("/placement-review/:token", async (req, res) => {
  const placement = await prisma.placement.findUnique({ where: { shareToken: req.params.token } });
  if (!placement || !placement.shareTokenExpiresAt || placement.shareTokenExpiresAt < new Date()) {
    return res.status(404).json({ error: "This link is no longer valid — ask CareFit for a new one." });
  }

  const entries = await prisma.placementShortlistEntry.findMany({
    where: { placementId: placement.id },
    include: { facility: true },
    orderBy: { rank: "asc" },
  });

  const facilities = entries
    .filter((e) => e.facility.okToShareWithFamilies === true)
    .map((e) => ({
      id: e.facility.id,
      name: e.facility.name,
      address: e.facility.address,
      careLevelsAccepted: e.facility.careLevelsAccepted,
      specialtyCare: e.facility.specialtyCare,
      culturalNotes: e.facility.culturalNotes,
      genderAccepted: e.facility.genderAccepted,
      privateRoomPricing: e.facility.privateRoomPricing,
      sharedRoomPricing: e.facility.sharedRoomPricing,
      contactName: e.facility.contactName,
      contactPhone: e.facility.contactPhone,
    }));

  res.json({ residentName: placement.residentName, facilities });
});

module.exports = router;
