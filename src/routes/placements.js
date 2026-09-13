// src/routes/placements.js
// CareFit's placement/referral business — matching a prospective resident to
// whichever AFH has an open bed that fits their needs, whether or not that
// AFH is a CareFit Connect customer. Deliberately NOT tenant-scoped (unlike
// every other route file) — everything here is admin-only and spans every
// tenant, since a placement doesn't belong to any one AFH until it's
// actually placed. See the "--- Placement ---" section of schema.prisma.
//
// Placement is the one lifecycle-tracked entity in this app: every stage
// change is recorded in PlacementEvent via recordTransition() (lib/
// placementEvents.js), unlike every other status field elsewhere (Employee,
// Resident, etc.), which is a bare overwrite with no history. This is
// Phase 1 of a larger staged-workflow build (see the plan for the full
// roadmap) — matching, tasks, documents, and follow-ups land in later
// phases; for now this is the stage spine + audit trail + a stage-only
// "next best action" hint.

const express = require("express");
const { prisma, requireAdmin } = require("../middleware/tenant");
const { recordTransition } = require("../lib/placementEvents");
const router = express.Router();

router.use(requireAdmin);

// Ordered lifecycle — see the plan doc for what each stage means
// operationally. Stored as a plain string (not a Prisma enum), matching
// every other status field in this schema.
const PLACEMENT_STAGES = [
  "NEW",
  "QUALIFYING",
  "READY_TO_MATCH",
  "MATCHING",
  "SHORTLISTED",
  "FAMILY_REVIEW",
  "INTRODUCTION",
  "DECISION_PENDING",
  "CONFIRMED",
  "MOVE_IN_SCHEDULED",
  "ACTIVE",
  "FOLLOW_UP",
  "COMPLETED",
  "CLOSED",
];
const CLOSURE_REASONS = ["family_withdrew", "no_suitable_match", "provider_unavailable", "chose_another_provider", "duplicate", "other"];
const CARE_LEVELS = ["level_1", "level_2", "level_3"];
const PAYER_TYPES = ["private_pay", "medicaid", "split"];

// Phase 1 only has stage-derived guidance (no matching/tasks/documents yet)
// — deliberately just a message, no actionLabel/actionLink, since there's no
// dedicated action beyond the stage dropdown and the existing Place button
// today. Later phases add real actions here as those features land.
function nextActionForStage(stage) {
  const MESSAGES = {
    NEW: "New request — confirm care needs and contact details, then move it to Qualifying.",
    QUALIFYING: "Gathering care needs and preferences. Move to Ready to Match once complete.",
    READY_TO_MATCH: "Ready for matching. Review the Facilities list for a fit, then move to Matching.",
    MATCHING: "Identifying candidate AFHs. Move to Shortlisted once you've picked a few.",
    SHORTLISTED: "Facilities shortlisted. Move to Family Review once you've shared them with the family.",
    FAMILY_REVIEW: "Family is reviewing the shortlist.",
    INTRODUCTION: "Introduction between family and facility is underway.",
    DECISION_PENDING: "Waiting on a decision from the family and/or facility.",
    CONFIRMED: "Facility and family have agreed. Move to Move-in Scheduled once a date is set.",
    MOVE_IN_SCHEDULED: "Move-in date is set. Move to Active once care has started.",
    ACTIVE: "Care has started. Move to Follow-up to begin post-placement check-ins.",
    FOLLOW_UP: "Post-placement follow-up is due.",
    COMPLETED: "Placement completed.",
    CLOSED: "Placement closed.",
  };
  return { message: MESSAGES[stage] || null };
}

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
    const occupied = isTenantLinked ? occupiedByHome.get(f.homeId) || 0 : f.currentResidents ?? null;
    const capacity = f.capacity;
    return {
      id: f.id,
      name: f.name,
      address: f.address,
      contactName: f.contactName,
      contactPhone: f.contactPhone,
      contactEmail: f.contactEmail,
      capacity,
      currentResidents: f.currentResidents,
      careLevelsAccepted: f.careLevelsAccepted,
      culturalNotes: f.culturalNotes,
      licenseNumber: f.licenseNumber,
      licenseExpiryDate: f.licenseExpiryDate,
      genderAccepted: f.genderAccepted,
      specialtyCare: f.specialtyCare,
      acceptsMedicaid: f.acceptsMedicaid,
      medicaidManagedCareOrgs: f.medicaidManagedCareOrgs,
      privateRoomPricing: f.privateRoomPricing,
      sharedRoomPricing: f.sharedRoomPricing,
      okToShareWithFamilies: f.okToShareWithFamilies,
      notes: f.notes,
      isTenantLinked,
      tenantName: isTenantLinked ? tenantNameById.get(f.tenantId) : null,
      occupied,
      openBeds: isTenantLinked && capacity != null ? Math.max(capacity - occupied, 0) : null,
      submittedByFacility: f.submittedByFacility,
      pendingReview: f.submittedByFacility && !f.reviewedAt,
    };
  });

  res.json(withCapacity);
});

const FACILITY_FIELDS = [
  "name",
  "address",
  "contactName",
  "contactPhone",
  "contactEmail",
  "capacity",
  "currentResidents",
  "careLevelsAccepted",
  "culturalNotes",
  "licenseNumber",
  "licenseExpiryDate",
  "genderAccepted",
  "specialtyCare",
  "acceptsMedicaid",
  "medicaidManagedCareOrgs",
  "privateRoomPricing",
  "sharedRoomPricing",
  "okToShareWithFamilies",
  "notes",
];

function buildFacilityData(body) {
  const data = {};
  for (const field of FACILITY_FIELDS) {
    if (body[field] === undefined) continue;
    if (field === "capacity" || field === "currentResidents") {
      data[field] = body[field] === "" || body[field] == null ? null : Number(body[field]);
    } else if (field === "licenseExpiryDate") {
      data[field] = body[field] ? new Date(body[field]) : null;
    } else if (field === "acceptsMedicaid" || field === "okToShareWithFamilies") {
      data[field] = body[field] === true || body[field] === "true" ? true : body[field] === false || body[field] === "false" ? false : null;
    } else {
      data[field] = body[field] || null;
    }
  }
  return data;
}

// POST /placements/facilities — add a purely external AFH (not a CareFit
// Connect customer) to the placement book. Tenant-linked facilities are
// created automatically by syncFacilitiesFromTenants above, never here.
router.post("/facilities", async (req, res) => {
  if (!req.body.name?.trim()) return res.status(400).json({ error: "name is required." });

  const facility = await prisma.placementFacility.create({
    data: { ...buildFacilityData(req.body), name: req.body.name.trim() },
  });
  res.status(201).json(facility);
});

// PATCH /placements/facilities/:id — correct/complete a facility's details.
// Mainly used when reviewing a self-submitted external facility (below).
router.patch("/facilities/:id", async (req, res) => {
  const facility = await prisma.placementFacility.findUnique({ where: { id: req.params.id } });
  if (!facility) return res.status(404).json({ error: "Facility not found." });

  const updated = await prisma.placementFacility.update({
    where: { id: facility.id },
    data: buildFacilityData(req.body),
  });
  res.json(updated);
});

// POST /placements/facilities/:id/review — an admin has looked at a
// facility an outside AFH submitted itself (see routes/publicIntake.js) and
// is vouching for it. Only after this can it be selected in the "Place"
// picker — see the guard in POST /inquiries/:id/place below.
router.post("/facilities/:id/review", async (req, res) => {
  const facility = await prisma.placementFacility.findUnique({ where: { id: req.params.id } });
  if (!facility) return res.status(404).json({ error: "Facility not found." });

  const updated = await prisma.placementFacility.update({
    where: { id: facility.id },
    data: { reviewedAt: new Date() },
  });
  res.json(updated);
});

// DELETE /placements/facilities/:id — only external facilities (never
// tenant-linked ones, which are just a mirror of a real Home and get
// re-synced automatically anyway) that have never actually been used in a
// completed placement.
router.delete("/facilities/:id", async (req, res) => {
  const facility = await prisma.placementFacility.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { placements: true } } },
  });
  if (!facility) return res.status(404).json({ error: "Facility not found." });
  if (facility.homeId) {
    return res.status(400).json({ error: "This facility mirrors a real CareFit Connect home and can't be removed here." });
  }
  if (facility._count.placements > 0) {
    return res.status(400).json({ error: "This facility has been used in a placement and can't be deleted." });
  }

  await prisma.placementFacility.delete({ where: { id: facility.id } });
  res.status(204).end();
});

// GET /placements/staff — CareFit admin staff, for assigning a placement to
// whoever owns it. Cross-tenant like everything else here — "staff" means
// CareFit's own team (the admin role), not an individual AFH's manager.
router.get("/staff", async (req, res) => {
  const staff = await prisma.user.findMany({
    where: { role: "admin" },
    select: { id: true, email: true },
    orderBy: { email: "asc" },
  });
  res.json(staff);
});

function withNextAction(placement) {
  return { ...placement, nextAction: nextActionForStage(placement.stage) };
}

// GET /placements/inquiries — the pipeline, most urgent/newest first.
router.get("/inquiries", async (req, res) => {
  const placements = await prisma.placement.findMany({
    include: {
      placedFacility: { select: { name: true, tenantId: true } },
      assignedTo: { select: { id: true, email: true } },
    },
    orderBy: [{ urgency: "desc" }, { createdAt: "desc" }],
  });
  res.json(placements.map(withNextAction));
});

// GET /placements/inquiries/:id — single placement, for the detail page.
router.get("/inquiries/:id", async (req, res) => {
  const placement = await prisma.placement.findUnique({
    where: { id: req.params.id },
    include: {
      placedFacility: { select: { name: true, tenantId: true } },
      assignedTo: { select: { id: true, email: true } },
    },
  });
  if (!placement) return res.status(404).json({ error: "Placement not found." });
  res.json(withNextAction(placement));
});

// GET /placements/inquiries/:id/events — the timeline/audit trail.
router.get("/inquiries/:id/events", async (req, res) => {
  const events = await prisma.placementEvent.findMany({
    where: { placementId: req.params.id },
    include: { changedBy: { select: { id: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(events);
});

// POST /placements/inquiries — log a new prospective-resident placement.
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
    specialtyCareNeeded,
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

  const placement = await prisma.placement.create({
    data: {
      residentName: residentName.trim(),
      contactName: contactName || null,
      contactPhone: contactPhone || null,
      contactEmail: contactEmail || null,
      referralSource: referralSource || null,
      careLevelNeeded,
      payerType,
      culturalPreferences: culturalPreferences || null,
      specialtyCareNeeded: specialtyCareNeeded || null,
      urgency: urgency === "urgent" ? "urgent" : "normal",
      notes: notes || null,
    },
  });
  await recordTransition(placement.id, { fromStage: null, toStage: placement.stage, changedById: req.userId, note: "Placement created" });
  res.status(201).json(withNextAction(placement));
});

// PATCH /placements/inquiries/:id — move through the lifecycle, edit
// details, or close with a reason. Placing one goes through POST
// .../place instead, since that action has its own required fields and
// side effects.
router.patch("/inquiries/:id", async (req, res) => {
  const placement = await prisma.placement.findUnique({ where: { id: req.params.id } });
  if (!placement) return res.status(404).json({ error: "Placement not found." });

  const { stage, closureReason, assignedToId, note, ...fields } = req.body;
  const data = { ...fields };
  let transition = null;

  if (stage !== undefined) {
    if (!PLACEMENT_STAGES.includes(stage)) {
      return res.status(400).json({ error: `stage must be one of: ${PLACEMENT_STAGES.join(", ")}` });
    }
    if (stage === "CONFIRMED" && placement.stage !== "CONFIRMED" && !placement.placedFacilityId) {
      return res.status(400).json({ error: "Use POST /placements/inquiries/:id/place to confirm a placement at a facility." });
    }
    data.stage = stage;
    data.closureReason = stage === "CLOSED" ? closureReason || placement.closureReason || null : null;
    transition = { fromStage: placement.stage, toStage: stage };
  }

  if (assignedToId !== undefined) {
    if (assignedToId) {
      const user = await prisma.user.findUnique({ where: { id: assignedToId } });
      if (!user) return res.status(400).json({ error: "assignedToId does not match a real user." });
    }
    data.assignedToId = assignedToId || null;
  }

  const updated = await prisma.placement.update({ where: { id: placement.id }, data });
  if (transition) {
    await recordTransition(placement.id, { ...transition, changedById: req.userId, note: note || null });
  }
  res.json(withNextAction(updated));
});

// POST /placements/inquiries/:id/place — mark a placement confirmed at a
// facility. When that facility is also a CareFit Connect tenant, this also
// creates the real Resident record there (validated the same way
// POST /residents does), and the placement moves to CONFIRMED (staff can
// advance it through Move-in Scheduled / Active themselves — there's no
// dedicated move-in flow yet, that's a later phase). For a purely external
// facility, this row is the only record of the outcome, so it moves
// straight to COMPLETED — there's nothing further CareFit tracks.
router.post("/inquiries/:id/place", async (req, res) => {
  const placement = await prisma.placement.findUnique({ where: { id: req.params.id } });
  if (!placement) return res.status(404).json({ error: "Placement not found." });
  if (placement.placedFacilityId) return res.status(400).json({ error: "This placement has already been placed." });

  const { facilityId, moveInDate, room, medicaidSplitPct, dateOfBirth } = req.body;
  if (!facilityId) return res.status(400).json({ error: "facilityId is required." });

  const facility = await prisma.placementFacility.findUnique({ where: { id: facilityId } });
  if (!facility) return res.status(404).json({ error: "Facility not found." });
  if (facility.submittedByFacility && !facility.reviewedAt) {
    return res.status(400).json({ error: "This facility was self-submitted and hasn't been reviewed yet — review it before placing anyone there." });
  }

  let placedResidentId = null;
  let toStage = "COMPLETED";

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
        name: placement.residentName,
        careLevel: placement.careLevelNeeded,
        payerType: placement.payerType,
        medicaidSplitPct: medicaidSplitPct ?? null,
        moveInDate: new Date(moveInDate),
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        room: room || null,
      },
    });
    placedResidentId = resident.id;
    toStage = "CONFIRMED";
  }

  const updated = await prisma.placement.update({
    where: { id: placement.id },
    data: {
      stage: toStage,
      closureReason: null,
      placedFacilityId: facility.id,
      placedResidentId,
      placedAt: new Date(),
    },
  });
  await recordTransition(placement.id, {
    fromStage: placement.stage,
    toStage,
    changedById: req.userId,
    note: `Placed at ${facility.name}`,
  });
  res.json(withNextAction(updated));
});

// DELETE /placements/inquiries/:id — only before a facility has been set.
// Once placed (CONFIRMED/COMPLETED via /place), it's the historical record
// of a real referral outcome (and may point at a real Resident), so it
// can't be removed — same "gone consequential, can't undo" rule as invoices.
router.delete("/inquiries/:id", async (req, res) => {
  const placement = await prisma.placement.findUnique({ where: { id: req.params.id } });
  if (!placement) return res.status(404).json({ error: "Placement not found." });
  if (placement.placedFacilityId) {
    return res.status(400).json({ error: "This placement has already been placed and can't be deleted — close it instead if it was placed in error." });
  }

  await prisma.placement.delete({ where: { id: placement.id } });
  res.status(204).end();
});

module.exports = router;
