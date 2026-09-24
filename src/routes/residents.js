// src/routes/residents.js
// Every query includes tenantId in the where clause — no exceptions. This is
// the pattern every other route file (employees, invoices, shifts) follows.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const ssn = require("../lib/ssn");
const { assignedHomeIds } = require("../lib/employeeScope");
const { ADL_DOMAINS } = require("../lib/adlDomains");
const { PERSONAL_CARE_TASKS, SHIFTS } = require("../lib/personalCareTasks");
const router = express.Router();

// An "employee" login (a caregiver's own, see middleware/employeeRestrict.js)
// is scoped to their assigned homes, not the whole tenant — every other role
// (admin/manager/kiosk) sees the full tenant, same as before. Returns null
// for those roles so callers can tell "no restriction" apart from "restricted
// to zero homes" (a brand-new employee login with no home assignment yet).
async function employeeHomeFilter(req) {
  if (req.userRole !== "employee") return null;
  return assignedHomeIds(prisma, req.employeeId);
}

// Fixed set of face-sheet contact "slots" — see ResidentContact in
// schema.prisma. Kept as a plain array (not a Prisma enum) to match this
// schema's existing convention.
const CONTACT_ROLES = [
  "emergency_contact_1",
  "emergency_contact_2",
  "social_worker",
  "financial_worker",
  "nurse_delegator",
  "pharmacy",
  "primary_care_doctor",
  "specialist_1",
  "specialist_2",
  "specialist_3",
];

// GET /residents — list all residents for the current tenant (or, for an
// employee login, only residents at homes they're assigned to)
router.get("/", async (req, res) => {
  const homeIds = await employeeHomeFilter(req);
  const residents = await prisma.resident.findMany({
    where: { tenantId: req.tenantId, ...(homeIds && { homeId: { in: homeIds } }) }, // never omit tenantId
    orderBy: { name: "asc" },
  });
  res.json(residents);
});

// GET /residents/:id — a single resident, still scoped to tenant (and, for
// an employee login, to their assigned homes)
router.get("/:id", async (req, res) => {
  const homeIds = await employeeHomeFilter(req);
  const resident = await prisma.resident.findFirst({
    where: {
      id: req.params.id,
      tenantId: req.tenantId, // findFirst, not findUnique —
      // findUnique by id alone would let a request from Tenant A fetch Tenant B's
      // resident just by guessing a UUID. findFirst with both conditions closes that gap.
      ...(homeIds && { homeId: { in: homeIds } }),
    },
    include: { contacts: true, home: { select: { name: true, address: true, phone: true, fax: true } } },
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

// GET /residents/:id/notes — freeform staff notes, newest first
router.get("/:id/notes", async (req, res) => {
  const homeIds = await employeeHomeFilter(req);
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId, ...(homeIds && { homeId: { in: homeIds } }) },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const notes = await prisma.residentNote.findMany({
    where: { residentId: resident.id, tenantId: req.tenantId },
    include: { author: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(notes);
});

// POST /residents/:id/notes — add a note, attributed to the logged-in user
router.post("/:id/notes", async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "content is required." });

  const homeIds = await employeeHomeFilter(req);
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId, ...(homeIds && { homeId: { in: homeIds } }) },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const note = await prisma.residentNote.create({
    data: { tenantId: req.tenantId, residentId: resident.id, authorId: req.userId, content: content.trim() },
    include: { author: { select: { email: true } } },
  });
  res.status(201).json(note);
});

// GET /residents/:id/adl — every personal-care task logged for this
// resident, newest first. See lib/personalCareTasks.js — `domain` is always
// one of PERSONAL_CARE_TASKS, `shift` one of SHIFTS.
router.get("/:id/adl", async (req, res) => {
  const homeIds = await employeeHomeFilter(req);
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId, ...(homeIds && { homeId: { in: homeIds } }) },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const entries = await prisma.adlEntry.findMany({
    where: { residentId: resident.id, tenantId: req.tenantId },
    include: { loggedBy: { select: { email: true } } },
    orderBy: { loggedAt: "desc" },
  });
  res.json(entries);
});

// POST /residents/:id/adl — log one personal-care task as done, attributed
// to the logged-in user. Append-only, like notes — logging a domain again
// (e.g. incontinence care a second time that shift) just adds another row,
// it doesn't overwrite the last one, since each occurrence is its own real
// event — matches how the paper Personal Care Record charts every occurrence.
router.post("/:id/adl", async (req, res) => {
  const { domain, shift, note } = req.body;
  if (!PERSONAL_CARE_TASKS.includes(domain)) {
    return res.status(400).json({ error: `domain must be one of: ${PERSONAL_CARE_TASKS.join(", ")}.` });
  }
  if (shift && !SHIFTS.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFTS.join(", ")}.` });
  }

  const homeIds = await employeeHomeFilter(req);
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId, ...(homeIds && { homeId: { in: homeIds } }) },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const entry = await prisma.adlEntry.create({
    data: { tenantId: req.tenantId, residentId: resident.id, domain, shift: shift || null, note: note?.trim() || null, loggedById: req.userId },
    include: { loggedBy: { select: { email: true } } },
  });
  res.status(201).json(entry);
});

// DELETE /residents/:id/adl/:entryId — undo a mis-tap. An admin/manager can
// remove any entry (same trust level they already have everywhere else), but
// an employee login can only remove its OWN entry, and only from today — a
// caregiver fixing a fat-fingered double-tap a minute ago is very different
// from anyone being able to quietly edit last week's chart after the fact,
// which is a real record once the shift has passed.
router.delete("/:id/adl/:entryId", async (req, res) => {
  const homeIds = await employeeHomeFilter(req);
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId, ...(homeIds && { homeId: { in: homeIds } }) },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const entry = await prisma.adlEntry.findFirst({
    where: { id: req.params.entryId, residentId: resident.id, tenantId: req.tenantId },
  });
  if (!entry) return res.status(404).json({ error: "Entry not found." });

  if (req.userRole === "employee") {
    const isOwn = entry.loggedById === req.userId;
    const isToday = new Date(entry.loggedAt).toDateString() === new Date().toDateString();
    if (!isOwn || !isToday) {
      return res.status(403).json({ error: "You can only remove your own entries from today. Ask a manager to correct older records." });
    }
  }

  await prisma.adlEntry.delete({ where: { id: entry.id } });
  res.status(204).end();
});

// GET /residents/:id/vitals — every vitals entry, newest first. Every field
// but who/when is optional, matching how sparsely the real paper form's
// vitals page is actually filled in.
router.get("/:id/vitals", async (req, res) => {
  const homeIds = await employeeHomeFilter(req);
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId, ...(homeIds && { homeId: { in: homeIds } }) },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const entries = await prisma.vitalsEntry.findMany({
    where: { residentId: resident.id, tenantId: req.tenantId },
    include: { loggedBy: { select: { email: true } } },
    orderBy: { loggedAt: "desc" },
  });
  res.json(entries);
});

// POST /residents/:id/vitals — log a vitals reading. Requires at least one
// actual measurement — an entry with nothing but a shift/note isn't a
// vitals reading, it belongs in Notes instead.
const VITALS_FIELDS = ["temperature", "pulse", "respirations", "bloodPressure", "weight", "intake", "output", "rom"];
router.post("/:id/vitals", async (req, res) => {
  const { shift, temperature, temperatureRoute, pulse, respirations, bloodPressure, weight, intake, output, rom, notes } = req.body;
  if (shift && !SHIFTS.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFTS.join(", ")}.` });
  }
  if (!VITALS_FIELDS.some((f) => req.body[f] !== undefined && req.body[f] !== "")) {
    return res.status(400).json({ error: "Enter at least one measurement." });
  }

  const homeIds = await employeeHomeFilter(req);
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId, ...(homeIds && { homeId: { in: homeIds } }) },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const entry = await prisma.vitalsEntry.create({
    data: {
      tenantId: req.tenantId,
      residentId: resident.id,
      shift: shift || null,
      temperature: temperature === "" || temperature == null ? null : Number(temperature),
      temperatureRoute: temperatureRoute || null,
      pulse: pulse === "" || pulse == null ? null : Number(pulse),
      respirations: respirations === "" || respirations == null ? null : Number(respirations),
      bloodPressure: bloodPressure || null,
      weight: weight === "" || weight == null ? null : Number(weight),
      intake: intake || null,
      output: output || null,
      rom: rom || null,
      notes: notes || null,
      loggedById: req.userId,
    },
    include: { loggedBy: { select: { email: true } } },
  });
  res.status(201).json(entry);
});

const RESIDENT_STATUSES = ["active", "discharging", "discharged"];
const DISCHARGE_REASONS = ["higher_level_of_care", "moved_in_with_family", "transferred", "deceased", "other"];

// PATCH /residents/:id/status — move a resident through discharge (or back to
// active, e.g. a data-entry correction). Never deletes anything — care plans,
// notes, and invoices all stay exactly as they are; a licensed AFH needs
// those records to survive a resident leaving, for exactly as long a
// "deceased" or "discharged" resident would matter for compliance.
router.patch("/:id/status", async (req, res) => {
  const { status, moveOutDate, dischargeReason } = req.body;
  if (!RESIDENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${RESIDENT_STATUSES.join(", ")}` });
  }
  if (dischargeReason && !DISCHARGE_REASONS.includes(dischargeReason)) {
    return res.status(400).json({ error: `dischargeReason must be one of: ${DISCHARGE_REASONS.join(", ")}` });
  }

  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const updated = await prisma.resident.update({
    where: { id: resident.id },
    data: {
      status,
      moveOutDate: status === "active" ? null : moveOutDate ? new Date(moveOutDate) : resident.moveOutDate ?? new Date(),
      dischargeReason: status === "active" ? null : dischargeReason ?? resident.dischargeReason,
    },
  });
  res.json(updated);
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

// PUT /residents/:id/face-sheet — one save for every field the printable
// face sheet needs: the flat fields on Resident, plus every contact "slot"
// (emergency contacts, providers) as ResidentContact rows. Upserts each
// contact by (residentId, role) so saving after filling in just one new
// contact doesn't require resending every other one.
router.put("/:id/face-sheet", async (req, res) => {
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const {
    middleName,
    socialSecurityNumber,
    clearSocialSecurityNumber,
    dnrStatus,
    advancedDirectivesType,
    medicareNumber,
    medicaidNumber,
    supplementaryInsurance,
    diagnosis,
    allergies,
    contacts,
  } = req.body;

  if (dnrStatus && !["yes", "no"].includes(dnrStatus)) {
    return res.status(400).json({ error: 'dnrStatus must be "yes" or "no".' });
  }

  // SSN: three cases, never a silent overwrite. The UI only ever holds the last
  // four digits, so it can't send the number back — "not provided" must mean
  // "leave what's stored alone", and clearing is an explicit flag.
  //   non-empty value  -> validate, encrypt, store (plus last four)
  //   clear flag       -> remove both
  //   otherwise        -> untouched
  const ssnData = {};
  if (typeof socialSecurityNumber === "string" && socialSecurityNumber.trim() !== "") {
    let canonical;
    try {
      canonical = ssn.normalizeSsn(socialSecurityNumber);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    // Fail closed: without a key we refuse to save the number at all rather
    // than fall back to storing it in plaintext.
    if (!ssn.keyConfigured()) {
      return res.status(503).json({ error: "Saving Social Security numbers isn't set up on the server yet. Ask CareFit support." });
    }
    ssnData.socialSecurityNumber = ssn.encryptSsn(canonical, resident.id);
    ssnData.socialSecurityLast4 = ssn.last4(canonical);
  } else if (clearSocialSecurityNumber === true) {
    ssnData.socialSecurityNumber = null;
    ssnData.socialSecurityLast4 = null;
  }

  await prisma.resident.update({
    where: { id: resident.id },
    data: {
      middleName: middleName || null,
      ...ssnData,
      dnrStatus: dnrStatus || null,
      advancedDirectivesType: advancedDirectivesType || null,
      medicareNumber: medicareNumber || null,
      medicaidNumber: medicaidNumber || null,
      supplementaryInsurance: supplementaryInsurance || null,
      diagnosis: diagnosis || null,
      allergies: allergies || null,
      // Stamped on every save so the printed sheet can show "Last updated" —
      // see the field comment in schema.prisma. Set here rather than via
      // @updatedAt so that unrelated writes (discharge, QBO id sync) don't
      // falsely claim the face sheet was reviewed.
      faceSheetUpdatedAt: new Date(),
    },
  });

  if (contacts && typeof contacts === "object") {
    for (const role of Object.keys(contacts)) {
      if (!CONTACT_ROLES.includes(role)) continue; // ignore unknown roles rather than 400 — keeps the form free to add slots later
      const c = contacts[role] || {};
      await prisma.residentContact.upsert({
        where: { residentId_role: { residentId: resident.id, role } },
        create: {
          residentId: resident.id,
          role,
          name: c.name || null,
          phone: c.phone || null,
          fax: c.fax || null,
          email: c.email || null,
          address: c.address || null,
          specialty: c.specialty || null,
        },
        update: {
          name: c.name || null,
          phone: c.phone || null,
          fax: c.fax || null,
          email: c.email || null,
          address: c.address || null,
          specialty: c.specialty || null,
        },
      });
    }
  }

  const withContacts = await prisma.resident.findUnique({
    where: { id: resident.id },
    include: { contacts: true, home: { select: { name: true, address: true, phone: true, fax: true } } },
  });
  res.json(withContacts);
});

// GET /residents/:id/social-security-number — the ONE place the full number is
// decrypted and returned, for the printed face sheet. Every other resident
// response omits the column entirely (see the global `omit` in
// middleware/tenant.js) and carries only socialSecurityLast4. Tenant-scoped like
// everything else; a kiosk login can't reach it (middleware/kioskRestrict.js).
// Each reveal is logged (who, which resident, when — never the value) so
// access to it can be traced in Railway's logs.
router.get("/:id/social-security-number", async (req, res) => {
  const resident = await prisma.resident.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
    select: { id: true, socialSecurityNumber: true }, // explicit select overrides the client-wide omit
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  let value = null;
  try {
    value = ssn.decryptSsn(resident.socialSecurityNumber, resident.id);
  } catch (err) {
    console.error(`[ssn] could not decrypt resident ${resident.id}: ${err.message}`);
    return res.status(500).json({ error: "This Social Security number can't be read. Re-enter it on the face sheet." });
  }
  if (value) console.info(`[ssn-reveal] user=${req.userId} tenant=${req.tenantId} resident=${resident.id}`);
  res.json({ socialSecurityNumber: value });
});

module.exports = router;
