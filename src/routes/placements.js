// src/routes/placements.js
// CareFit's placement/referral business — matching a prospective resident to
// whichever AFH has an open bed that fits their needs, whether or not that
// AFH is a CareFit Connect customer. Deliberately NOT tenant-scoped (unlike
// every other route file) — everything here is admin-only and spans every
// tenant, since a placement inquiry doesn't belong to any one AFH until it's
// actually placed. See the "--- Placement ---" section of schema.prisma.

const express = require("express");
const { prisma, requireAdmin } = require("../middleware/tenant");
const router = express.Router();

router.use(requireAdmin);

const INQUIRY_STATUSES = ["new", "touring", "pending", "placed", "declined"];
const CARE_LEVELS = ["level_1", "level_2", "level_3"];
const PAYER_TYPES = ["private_pay", "medicaid", "split"];

// Keeps PlacementFacility rows in sync with real Homes, lazily — any Home
// across any tenant that doesn't already have a linked facility gets one
// created automatically, so an admin never has to manually re-enter a home
// that's already a CareFit Connect customer. Purely external facilities
// (added via POST /facilities below) are untouched by this.
async function syncFacilitiesFromTenants() {
  const homes = await prisma.home.findMany({ select: { id: true, tenantId: true, name: true, capacity: true } });
  const linked = await prisma.placementFacility.findMany({
    where: { homeId: { in: homes.map((h) => h.id) } },
    select: { homeId: true },
  });
  const linkedHomeIds = new Set(linked.map((f) => f.homeId));
  const missing = homes.filter((h) => !linkedHomeIds.has(h.id));
  if (missing.length === 0) return;

  await prisma.placementFacility.createMany({
    data: missing.map((h) => ({ name: h.name, tenantId: h.tenantId, homeId: h.id, capacity: h.capacity })),
  });
}

// GET /placements/facilities — every facility CareFit places into, with live
// occupancy for tenant-linked ones and the manually-entered capacity for
// external ones.
router.get("/facilities", async (req, res) => {
  await syncFacilitiesFromTenants();

  const facilities = await prisma.placementFacility.findMany({ orderBy: { name: "asc" } });

  const tenantLinked = facilities.filter((f) => f.homeId);
  const activeResidents = await prisma.resident.findMany({
    where: { homeId: { in: tenantLinked.map((f) => f.homeId) }, status: "active" },
    select: { homeId: true, careLevel: true },
  });
  const occupiedByHome = new Map();
  for (const r of activeResidents) {
    occupiedByHome.set(r.homeId, (occupiedByHome.get(r.homeId) || 0) + 1);
  }

  const tenants = await prisma.tenant.findMany({
    where: { id: { in: tenantLinked.map((f) => f.tenantId) } },
    select: { id: true, name: true },
  });
  const tenantNameById = new Map(tenants.map((t) => [t.id, t.name]));

  const withCapacity = facilities.map((f) => {
    const isTenantLinked = !!f.homeId;
    const occupied = isTenantLinked ? occupiedByHome.get(f.homeId) || 0 : null;
    const capacity = f.capacity;
    return {
      id: f.id,
      name: f.name,
      address: f.address,
      contactName: f.contactName,
      contactPhone: f.contactPhone,
      contactEmail: f.contactEmail,
      capacity,
      careLevelsAccepted: f.careLevelsAccepted,
      culturalNotes: f.culturalNotes,
      notes: f.notes,
      isTenantLinked,
      tenantName: isTenantLinked ? tenantNameById.get(f.tenantId) : null,
      occupied,
      openBeds: isTenantLinked && capacity != null ? Math.max(capacity - occupied, 0) : null,
    };
  });

  res.json(withCapacity);
});

// POST /placements/facilities — add a purely external AFH (not a CareFit
// Connect customer) to the placement book. Tenant-linked facilities are
// created automatically by syncFacilitiesFromTenants above, never here.
router.post("/facilities", async (req, res) => {
  const { name, address, contactName, contactPhone, contactEmail, capacity, careLevelsAccepted, culturalNotes, notes } =
    req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required." });

  const facility = await prisma.placementFacility.create({
    data: {
      name: name.trim(),
      address: address || null,
      contactName: contactName || null,
      contactPhone: contactPhone || null,
      contactEmail: contactEmail || null,
      capacity: capacity != null && capacity !== "" ? Number(capacity) : null,
      careLevelsAccepted: careLevelsAccepted || null,
      culturalNotes: culturalNotes || null,
      notes: notes || null,
    },
  });
  res.status(201).json(facility);
});

// GET /placements/inquiries — the pipeline, most urgent/newest first.
router.get("/inquiries", async (req, res) => {
  const inquiries = await prisma.placementInquiry.findMany({
    include: { placedFacility: { select: { name: true, tenantId: true } } },
    orderBy: [{ urgency: "desc" }, { createdAt: "desc" }],
  });
  res.json(inquiries);
});

// POST /placements/inquiries — log a new prospective-resident inquiry.
router.post("/inquiries", async (req, res) => {
  const {
    residentName,
    contactName,
    contactPhone,
    contactEmail,
    referralSource,
    careLevelNeeded,
    payerType,
    culturalPreferences,
    urgency,
    notes,
  } = req.body;

  if (!residentName?.trim() || !careLevelNeeded || !payerType) {
    return res.status(400).json({ error: "residentName, careLevelNeeded, and payerType are required." });
  }
  if (!CARE_LEVELS.includes(careLevelNeeded)) {
    return res.status(400).json({ error: `careLevelNeeded must be one of: ${CARE_LEVELS.join(", ")}` });
  }
  if (!PAYER_TYPES.includes(payerType)) {
    return res.status(400).json({ error: `payerType must be one of: ${PAYER_TYPES.join(", ")}` });
  }

  const inquiry = await prisma.placementInquiry.create({
    data: {
      residentName: residentName.trim(),
      contactName: contactName || null,
      contactPhone: contactPhone || null,
      contactEmail: contactEmail || null,
      referralSource: referralSource || null,
      careLevelNeeded,
      payerType,
      culturalPreferences: culturalPreferences || null,
      urgency: urgency === "urgent" ? "urgent" : "normal",
      notes: notes || null,
    },
  });
  res.status(201).json(inquiry);
});

// PATCH /placements/inquiries/:id — move through the pipeline, edit details,
// or decline with a reason. Placing one goes through POST .../place instead,
// since that action has its own required fields and side effects.
router.patch("/inquiries/:id", async (req, res) => {
  const inquiry = await prisma.placementInquiry.findUnique({ where: { id: req.params.id } });
  if (!inquiry) return res.status(404).json({ error: "Inquiry not found." });

  const { status, declinedReason, ...fields } = req.body;
  const data = { ...fields };

  if (status !== undefined) {
    if (!INQUIRY_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${INQUIRY_STATUSES.join(", ")}` });
    }
    if (status === "placed") {
      return res.status(400).json({ error: "Use POST /placements/inquiries/:id/place to mark an inquiry placed." });
    }
    data.status = status;
    data.declinedReason = status === "declined" ? declinedReason || inquiry.declinedReason || null : null;
  }

  const updated = await prisma.placementInquiry.update({ where: { id: inquiry.id }, data });
  res.json(updated);
});

// POST /placements/inquiries/:id/place — mark an inquiry placed at a
// facility. When that facility is also a CareFit Connect tenant, this also
// creates the real Resident record there (validated the same way
// POST /residents does); for a purely external facility, this inquiry row is
// the only record of the outcome.
router.post("/inquiries/:id/place", async (req, res) => {
  const inquiry = await prisma.placementInquiry.findUnique({ where: { id: req.params.id } });
  if (!inquiry) return res.status(404).json({ error: "Inquiry not found." });
  if (inquiry.status === "placed") return res.status(400).json({ error: "This inquiry is already placed." });

  const { facilityId, moveInDate, room, medicaidSplitPct, dateOfBirth } = req.body;
  if (!facilityId) return res.status(400).json({ error: "facilityId is required." });

  const facility = await prisma.placementFacility.findUnique({ where: { id: facilityId } });
  if (!facility) return res.status(404).json({ error: "Facility not found." });

  let placedResidentId = null;

  if (facility.tenantId && facility.homeId) {
    if (!moveInDate) {
      return res.status(400).json({ error: "moveInDate is required to place someone at a CareFit Connect facility." });
    }
    // Same cross-tenant guard as POST /residents — confirm the home still
    // belongs to the facility's own tenant before creating the resident.
    const home = await prisma.home.findFirst({ where: { id: facility.homeId, tenantId: facility.tenantId } });
    if (!home) return res.status(404).json({ error: "This facility's home no longer exists." });

    const resident = await prisma.resident.create({
      data: {
        tenantId: facility.tenantId,
        homeId: facility.homeId,
        name: inquiry.residentName,
        careLevel: inquiry.careLevelNeeded,
        payerType: inquiry.payerType,
        medicaidSplitPct: medicaidSplitPct ?? null,
        moveInDate: new Date(moveInDate),
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        room: room || null,
      },
    });
    placedResidentId = resident.id;
  }

  const updated = await prisma.placementInquiry.update({
    where: { id: inquiry.id },
    data: {
      status: "placed",
      declinedReason: null,
      placedFacilityId: facility.id,
      placedResidentId,
      placedAt: new Date(),
    },
  });
  res.json(updated);
});

module.exports = router;
