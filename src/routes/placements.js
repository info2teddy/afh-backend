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
const crypto = require("crypto");
const multer = require("multer");
const { prisma, requireAdmin } = require("../middleware/tenant");
const { recordTransition } = require("../lib/placementEvents");
const { createTasksForStage, createFirstFollowup, advanceFollowup, withStatus } = require("../lib/placementTasks");
const router = express.Router();

// Same accepted-type set as expenses.js's receipt uploads and onboarding's
// document verification — the established pattern for "upload a document"
// in this app.
const ACCEPTED_DOCUMENT_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_DOCUMENT_TYPES.has(file.mimetype)) {
      return cb(new Error("Only PDF or image (PNG/JPEG/WEBP) files are supported."));
    }
    cb(null, true);
  },
});
const DOCUMENT_CATEGORIES = ["family", "provider", "placement", "agreement", "other"];
const COMMUNICATION_METHODS = ["call", "email", "message", "in_person", "other"];

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

// --- Matching (Phase 2) ---------------------------------------------
// A real, deterministic, explainable score — never an ML-style confidence
// number. Each criterion below is either applicable or not (both sides have
// real data to compare) and either matched or not; the score is just
// matched/applicable, so every point is traceable to the same checklist the
// UI shows under "Why this match?" (spec §11). Deliberately NO distance/
// location scoring — there's no geocoding anywhere in this app (see the
// plan doc) — and NO gender criterion, since neither Placement nor Resident
// has a gender field to compare against; inventing one would be exactly the
// kind of fabricated precision this project has always avoided.
function tokenize(text) {
  return (text || "").toLowerCase().match(/[a-z]{3,}/g) || [];
}
const MATCH_STOPWORDS = new Set(["the", "and", "with", "needs", "need", "care", "support", "preferred", "speaking", "household"]);
function keywordOverlap(haystack, needle) {
  const haystackWords = new Set(tokenize(haystack).filter((w) => !MATCH_STOPWORDS.has(w)));
  return tokenize(needle)
    .filter((w) => !MATCH_STOPWORDS.has(w))
    .some((w) => haystackWords.has(w));
}

function buildMatchCriteria(placement, facility) {
  const criteria = [];

  if (facility.careLevelsAccepted) {
    const levelDigit = placement.careLevelNeeded?.replace("level_", "");
    criteria.push({
      key: "careLevel",
      label: "Accepts the required level of care",
      matched: levelDigit ? facility.careLevelsAccepted.toLowerCase().includes(levelDigit) : false,
    });
  }
  if (placement.payerType !== "private_pay" && facility.acceptsMedicaid != null) {
    criteria.push({ key: "medicaid", label: "Accepts Medicaid", matched: facility.acceptsMedicaid === true });
  }
  if (placement.culturalPreferences && facility.culturalNotes) {
    criteria.push({
      key: "cultural",
      label: "Matches language / faith / cultural preference",
      matched: keywordOverlap(facility.culturalNotes, placement.culturalPreferences),
    });
  }
  if (placement.specialtyCareNeeded && facility.specialtyCare) {
    criteria.push({
      key: "specialty",
      label: "Supports the specialty care needed",
      matched: keywordOverlap(facility.specialtyCare, placement.specialtyCareNeeded),
    });
  }

  const applicable = criteria.length;
  const matchedCount = criteria.filter((c) => c.matched).length;
  // null (not a fake 0%) when nothing could actually be compared — e.g. a
  // brand-new facility record with none of the optional fields filled in.
  const score = applicable > 0 ? Math.round((matchedCount / applicable) * 100) : null;
  return { criteria, score };
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

// Shared by GET /facilities and GET /inquiries/:id/matches — every facility
// CareFit places into, with live occupancy for tenant-linked ones and the
// manually-entered capacity for external ones.
async function getFacilitiesWithCapacity() {
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

  return facilities.map((f) => {
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
}

// GET /placements/facilities — every facility CareFit places into, with live
// occupancy for tenant-linked ones and the manually-entered capacity for
// external ones.
router.get("/facilities", async (req, res) => {
  res.json(await getFacilitiesWithCapacity());
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

  // Next Best Action gets sharper here than on the list (which stays
  // stage-only to keep that query cheap): if there's a real open task,
  // surface the most urgent one (overdue first, then earliest due) instead
  // of the generic stage message.
  const openTasks = (await prisma.placementTask.findMany({ where: { placementId: placement.id, completedAt: null } })).map(withStatus);
  const result = withNextAction(placement);
  const mostUrgent = openTasks.find((t) => t.status === "overdue") || openTasks.sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0))[0];
  if (mostUrgent) {
    result.nextAction = { message: mostUrgent.title, taskId: mostUrgent.id, overdue: mostUrgent.status === "overdue" };
  }
  res.json(result);
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

// --- Tasks (Phase 3) ---------------------------------------------------
// GET /placements/inquiries/:id/tasks — every to-do for this placement
// (move-in checklist items, follow-ups, general lifecycle tasks — see
// lib/placementTasks.js), with a computed status (done/overdue/pending).
router.get("/inquiries/:id/tasks", async (req, res) => {
  const tasks = await prisma.placementTask.findMany({
    where: { placementId: req.params.id },
    include: { assignedTo: { select: { id: true, email: true } } },
    orderBy: [{ completedAt: "asc" }, { dueDate: "asc" }, { createdAt: "asc" }],
  });
  res.json(tasks.map(withStatus));
});

// PATCH /placements/tasks/:id — complete/reopen a task, or edit its due
// date/priority/assignee/notes. Marking a follow-up task (type followup_*)
// complete auto-creates the next one in the sequence (spec §19).
router.patch("/tasks/:id", async (req, res) => {
  const task = await prisma.placementTask.findUnique({ where: { id: req.params.id }, include: { placement: true } });
  if (!task) return res.status(404).json({ error: "Task not found." });

  const { completedAt, dueDate, priority, assignedToId, notes } = req.body;
  if (priority !== undefined && priority && !["normal", "high"].includes(priority)) {
    return res.status(400).json({ error: "priority must be one of: normal, high" });
  }

  const data = {};
  if (completedAt !== undefined) data.completedAt = completedAt ? new Date(completedAt) : null;
  if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
  if (priority !== undefined) data.priority = priority || "normal";
  if (assignedToId !== undefined) data.assignedToId = assignedToId || null;
  if (notes !== undefined) data.notes = notes || null;

  const updated = await prisma.placementTask.update({ where: { id: task.id }, data });

  const justCompleted = data.completedAt && !task.completedAt;
  if (justCompleted && task.type.startsWith("followup_") && task.placement.placedResidentId) {
    const resident = await prisma.resident.findUnique({ where: { id: task.placement.placedResidentId } });
    if (resident) await advanceFollowup(task, resident.moveInDate);
  }

  res.json(withStatus(updated));
});

// GET /placements/inquiries/:id/matches — ranked candidate facilities. Hard
// filters (excluded entirely, not just scored low): explicitly full
// (openBeds === 0, only when it's actually known) and explicitly no
// Medicaid when the placement needs it. Everything else is a soft, scored
// criterion — see buildMatchCriteria above.
router.get("/inquiries/:id/matches", async (req, res) => {
  const placement = await prisma.placement.findUnique({ where: { id: req.params.id } });
  if (!placement) return res.status(404).json({ error: "Placement not found." });

  const facilities = await getFacilitiesWithCapacity();
  const eligible = facilities.filter((f) => {
    if (f.openBeds === 0) return false;
    if (placement.payerType !== "private_pay" && f.acceptsMedicaid === false) return false;
    return true;
  });

  const matches = eligible
    .map((f) => ({ facility: f, ...buildMatchCriteria(placement, f) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.facility.openBeds ?? 0) - (a.facility.openBeds ?? 0));

  res.json(matches);
});

// --- Shortlist (Phase 2) ---------------------------------------------
// GET /placements/inquiries/:id/shortlist
router.get("/inquiries/:id/shortlist", async (req, res) => {
  const entries = await prisma.placementShortlistEntry.findMany({
    where: { placementId: req.params.id },
    include: { facility: true },
    orderBy: { rank: "asc" },
  });
  res.json(entries);
});

// POST /placements/inquiries/:id/shortlist — add a facility, appended to the end.
router.post("/inquiries/:id/shortlist", async (req, res) => {
  const { facilityId } = req.body;
  if (!facilityId) return res.status(400).json({ error: "facilityId is required." });

  const facility = await prisma.placementFacility.findUnique({ where: { id: facilityId } });
  if (!facility) return res.status(404).json({ error: "Facility not found." });

  const maxRank = await prisma.placementShortlistEntry.aggregate({
    where: { placementId: req.params.id },
    _max: { rank: true },
  });

  const entry = await prisma.placementShortlistEntry
    .create({
      data: { placementId: req.params.id, facilityId, rank: (maxRank._max.rank ?? -1) + 1 },
      include: { facility: true },
    })
    .catch((err) => {
      if (err.code === "P2002") return null; // already shortlisted
      throw err;
    });
  if (!entry) return res.status(400).json({ error: "This facility is already shortlisted." });

  res.status(201).json(entry);
});

// PATCH /placements/inquiries/:id/shortlist/reorder — body: { facilityIds: [...] }
// in the new display order.
router.patch("/inquiries/:id/shortlist/reorder", async (req, res) => {
  const { facilityIds } = req.body;
  if (!Array.isArray(facilityIds)) return res.status(400).json({ error: "facilityIds must be an array." });

  await prisma.$transaction(
    facilityIds.map((facilityId, rank) =>
      prisma.placementShortlistEntry.updateMany({
        where: { placementId: req.params.id, facilityId },
        data: { rank },
      })
    )
  );
  const entries = await prisma.placementShortlistEntry.findMany({
    where: { placementId: req.params.id },
    include: { facility: true },
    orderBy: { rank: "asc" },
  });
  res.json(entries);
});

// DELETE /placements/inquiries/:id/shortlist/:facilityId
router.delete("/inquiries/:id/shortlist/:facilityId", async (req, res) => {
  await prisma.placementShortlistEntry.deleteMany({
    where: { placementId: req.params.id, facilityId: req.params.facilityId },
  });
  res.status(204).end();
});

// --- Family Review sharing (Phase 2) ----------------------------------
// POST /placements/inquiries/:id/share — (re)generate the family-facing
// link, replacing any previous one (old links stop working immediately).
// Expires in 30 days; DELETE below revokes it outright.
router.post("/inquiries/:id/share", async (req, res) => {
  const placement = await prisma.placement.findUnique({ where: { id: req.params.id } });
  if (!placement) return res.status(404).json({ error: "Placement not found." });

  const shareToken = crypto.randomBytes(24).toString("hex");
  const shareTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const updated = await prisma.placement.update({
    where: { id: placement.id },
    data: { shareToken, shareTokenExpiresAt },
  });
  res.json({ shareToken: updated.shareToken, shareTokenExpiresAt: updated.shareTokenExpiresAt });
});

// DELETE /placements/inquiries/:id/share — revoke immediately.
router.delete("/inquiries/:id/share", async (req, res) => {
  await prisma.placement.update({
    where: { id: req.params.id },
    data: { shareToken: null, shareTokenExpiresAt: null },
  });
  res.status(204).end();
});

// --- Introductions & decisions (Phase 2) ------------------------------
// GET /placements/inquiries/:id/introductions
router.get("/inquiries/:id/introductions", async (req, res) => {
  const introductions = await prisma.placementIntroduction.findMany({
    where: { placementId: req.params.id },
    include: { facility: { select: { name: true } }, staff: { select: { id: true, email: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(introductions);
});

const INTRO_METHODS = ["phone", "in_person", "video", "tour"];
const INTRO_OUTCOMES = ["interested", "needs_followup", "declined", "scheduled_visit", "completed"];
const FAMILY_DECISIONS = ["accept", "decline", "need_another_option"];
const PROVIDER_DECISIONS = ["accept", "decline", "need_more_info"];

// POST /placements/inquiries/:id/introductions — schedule/log one.
router.post("/inquiries/:id/introductions", async (req, res) => {
  const { facilityId, scheduledAt, method, notes } = req.body;
  if (!facilityId) return res.status(400).json({ error: "facilityId is required." });
  if (method && !INTRO_METHODS.includes(method)) {
    return res.status(400).json({ error: `method must be one of: ${INTRO_METHODS.join(", ")}` });
  }
  const facility = await prisma.placementFacility.findUnique({ where: { id: facilityId } });
  if (!facility) return res.status(404).json({ error: "Facility not found." });

  const intro = await prisma.placementIntroduction.create({
    data: {
      placementId: req.params.id,
      facilityId,
      staffId: req.userId,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      method: method || null,
      notes: notes || null,
    },
    include: { facility: { select: { name: true } }, staff: { select: { id: true, email: true } } },
  });
  res.status(201).json(intro);
});

// PATCH /placements/introductions/:id — update outcome/decisions. When both
// sides accept, the placement auto-advances to CONFIRMED (spec §15) — this
// only sets placedFacilityId as a pointer, it does NOT create a Resident or
// require a move-in date yet; that still happens via POST .../place, same
// as Phase 1. When either side declines, the placement returns to
// SHORTLISTED so staff can try another candidate without losing history.
router.patch("/introductions/:id", async (req, res) => {
  const intro = await prisma.placementIntroduction.findUnique({
    where: { id: req.params.id },
    include: { placement: true, facility: true },
  });
  if (!intro) return res.status(404).json({ error: "Introduction not found." });

  const { scheduledAt, method, notes, outcome, familyDecision, providerDecision } = req.body;
  if (method !== undefined && method && !INTRO_METHODS.includes(method)) {
    return res.status(400).json({ error: `method must be one of: ${INTRO_METHODS.join(", ")}` });
  }
  if (outcome !== undefined && outcome && !INTRO_OUTCOMES.includes(outcome)) {
    return res.status(400).json({ error: `outcome must be one of: ${INTRO_OUTCOMES.join(", ")}` });
  }
  if (familyDecision !== undefined && familyDecision && !FAMILY_DECISIONS.includes(familyDecision)) {
    return res.status(400).json({ error: `familyDecision must be one of: ${FAMILY_DECISIONS.join(", ")}` });
  }
  if (providerDecision !== undefined && providerDecision && !PROVIDER_DECISIONS.includes(providerDecision)) {
    return res.status(400).json({ error: `providerDecision must be one of: ${PROVIDER_DECISIONS.join(", ")}` });
  }

  const data = {};
  if (scheduledAt !== undefined) data.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
  if (method !== undefined) data.method = method || null;
  if (notes !== undefined) data.notes = notes || null;
  if (outcome !== undefined) data.outcome = outcome || null;
  if (familyDecision !== undefined) data.familyDecision = familyDecision || null;
  if (providerDecision !== undefined) data.providerDecision = providerDecision || null;

  const updated = await prisma.placementIntroduction.update({ where: { id: intro.id }, data });

  const resolvedFamily = "familyDecision" in data ? data.familyDecision : intro.familyDecision;
  const resolvedProvider = "providerDecision" in data ? data.providerDecision : intro.providerDecision;
  const currentStage = intro.placement.stage;

  if (resolvedFamily === "accept" && resolvedProvider === "accept" && currentStage !== "CONFIRMED") {
    await prisma.placement.update({
      where: { id: intro.placementId },
      data: { stage: "CONFIRMED", placedFacilityId: intro.facilityId },
    });
    await recordTransition(intro.placementId, {
      fromStage: currentStage,
      toStage: "CONFIRMED",
      changedById: req.userId,
      note: `Family and ${intro.facility.name} both accepted`,
    });
    await createTasksForStage(intro.placementId, "CONFIRMED", { assignedToId: intro.placement.assignedToId });
  } else if (
    (resolvedFamily === "decline" || resolvedProvider === "decline") &&
    currentStage !== "SHORTLISTED" &&
    !["CONFIRMED", "MOVE_IN_SCHEDULED", "ACTIVE", "FOLLOW_UP", "COMPLETED"].includes(currentStage)
  ) {
    await prisma.placement.update({ where: { id: intro.placementId }, data: { stage: "SHORTLISTED" } });
    await recordTransition(intro.placementId, {
      fromStage: currentStage,
      toStage: "SHORTLISTED",
      changedById: req.userId,
      note: `${resolvedFamily === "decline" ? "Family" : intro.facility.name} declined`,
    });
    await createTasksForStage(intro.placementId, "SHORTLISTED", { assignedToId: intro.placement.assignedToId });
  }

  res.json(updated);
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
  await createTasksForStage(placement.id, placement.stage, {});
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
    // Business rule (spec §30): can't become ACTIVE without a real move-in
    // event — requires an actual Resident record whose move-in date has
    // arrived, not just a stage flip. External-facility placements never
    // reach ACTIVE at all (POST .../place sends them straight to COMPLETED
    // since CareFit doesn't operate that home to confirm a real move-in).
    if (stage === "ACTIVE" && placement.stage !== "ACTIVE") {
      if (!placement.placedResidentId) {
        return res.status(400).json({ error: "Active requires a real move-in — place this at a CareFit Connect facility with a move-in date first." });
      }
      const resident = await prisma.resident.findUnique({ where: { id: placement.placedResidentId } });
      if (!resident || new Date(resident.moveInDate) > new Date()) {
        return res.status(400).json({ error: "This resident's move-in date hasn't arrived yet." });
      }
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
    await createTasksForStage(placement.id, stage, { assignedToId: updated.assignedToId });
    if (stage === "ACTIVE") {
      const resident = await prisma.resident.findUnique({ where: { id: updated.placedResidentId } });
      await createFirstFollowup(placement.id, resident.moveInDate, { assignedToId: updated.assignedToId });
    }
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
  if (placement.placedAt) return res.status(400).json({ error: "This placement has already been placed." });

  // Falls back to the facility a decision already agreed on (see PATCH
  // /introductions/:id), so finalizing after a decision doesn't require
  // re-picking the same facility.
  const { moveInDate, room, medicaidSplitPct, dateOfBirth } = req.body;
  const facilityId = req.body.facilityId || placement.placedFacilityId;
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
  await createTasksForStage(placement.id, toStage, { assignedToId: updated.assignedToId });
  res.json(withNextAction(updated));
});

// DELETE /placements/inquiries/:id — only before it's actually been placed
// (POST .../place). A decision-accepted-but-not-yet-finalized placement
// (placedFacilityId set, placedAt still null) can still be deleted — close
// it instead if you want to preserve the history. Once placed, it's the
// historical record of a real referral outcome (and may point at a real
// Resident), so it can't be removed — same "gone consequential, can't undo"
// rule as invoices.
router.delete("/inquiries/:id", async (req, res) => {
  const placement = await prisma.placement.findUnique({ where: { id: req.params.id } });
  if (!placement) return res.status(404).json({ error: "Placement not found." });
  if (placement.placedAt) {
    return res.status(400).json({ error: "This placement has already been placed and can't be deleted — close it instead if it was placed in error." });
  }

  await prisma.placement.delete({ where: { id: placement.id } });
  res.status(204).end();
});

// --- Documents (Phase 4) ------------------------------------------------
// GET /placements/inquiries/:id/documents — metadata only, not the file
// itself (see GET /documents/:id/file below), same split as expenses.js.
router.get("/inquiries/:id/documents", async (req, res) => {
  const documents = await prisma.placementDocument.findMany({
    where: { placementId: req.params.id },
    select: {
      id: true,
      category: true,
      name: true,
      mimeType: true,
      required: true,
      createdAt: true,
      uploadedBy: { select: { id: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(documents);
});

// POST /placements/inquiries/:id/documents — upload one.
router.post("/inquiries/:id/documents", documentUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "A file is required." });
  const { category, required } = req.body;
  if (!category || !DOCUMENT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${DOCUMENT_CATEGORIES.join(", ")}` });
  }

  const document = await prisma.placementDocument.create({
    data: {
      placementId: req.params.id,
      category,
      name: req.file.originalname,
      mimeType: req.file.mimetype,
      data: req.file.buffer,
      required: required === true || required === "true",
      uploadedById: req.userId,
    },
    select: { id: true, category: true, name: true, mimeType: true, required: true, createdAt: true },
  });
  res.status(201).json(document);
});

// GET /placements/documents/:id/file — the raw uploaded file.
router.get("/documents/:id/file", async (req, res) => {
  const document = await prisma.placementDocument.findUnique({ where: { id: req.params.id } });
  if (!document) return res.status(404).json({ error: "Document not found." });
  res.set("Content-Type", document.mimeType);
  res.set("Content-Disposition", `inline; filename="${document.name}"`);
  res.send(document.data);
});

// DELETE /placements/documents/:id
router.delete("/documents/:id", async (req, res) => {
  const document = await prisma.placementDocument.findUnique({ where: { id: req.params.id } });
  if (!document) return res.status(404).json({ error: "Document not found." });
  await prisma.placementDocument.delete({ where: { id: document.id } });
  res.status(204).end();
});

// --- Communications (Phase 4) -------------------------------------------
// A manual log, not a real telephony/email integration — see the model
// comment in schema.prisma for why.
// GET /placements/inquiries/:id/communications
router.get("/inquiries/:id/communications", async (req, res) => {
  const communications = await prisma.placementCommunication.findMany({
    where: { placementId: req.params.id },
    include: { loggedBy: { select: { id: true, email: true } } },
    orderBy: { occurredAt: "desc" },
  });
  res.json(communications);
});

// POST /placements/inquiries/:id/communications — log one.
router.post("/inquiries/:id/communications", async (req, res) => {
  const { method, summary, occurredAt } = req.body;
  if (!method || !COMMUNICATION_METHODS.includes(method)) {
    return res.status(400).json({ error: `method must be one of: ${COMMUNICATION_METHODS.join(", ")}` });
  }
  if (!summary?.trim()) return res.status(400).json({ error: "summary is required." });

  const communication = await prisma.placementCommunication.create({
    data: {
      placementId: req.params.id,
      method,
      summary: summary.trim(),
      loggedById: req.userId,
      occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
    },
    include: { loggedBy: { select: { id: true, email: true } } },
  });
  res.status(201).json(communication);
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes("PDF or image")) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
