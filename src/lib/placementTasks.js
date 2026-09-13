// src/lib/placementTasks.js
// Auto-generated to-dos for a placement's lifecycle (spec §17 move-in
// checklist, §19 follow-ups, §21 general tasks) — created alongside stage
// transitions in routes/placements.js, the same way recordTransition()
// writes the audit trail. Idempotent: never creates a second task of a
// type that already exists for a placement, so bouncing between stages
// (e.g. a decline sending it back to SHORTLISTED) doesn't pile up
// duplicates.
const { prisma } = require("../middleware/tenant");

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// Keyed by the stage the placement is in when the task should exist —
// "NEW" fires right at creation (spec §21: "Placement created: → Complete
// qualification"), not when leaving NEW for QUALIFYING.
const STAGE_TASKS = {
  NEW: [{ type: "qualification", title: "Complete qualification", dueDate: () => daysFromNow(2) }],
  READY_TO_MATCH: [{ type: "review_matches", title: "Review matches and build a shortlist", dueDate: () => daysFromNow(3) }],
  SHORTLISTED: [{ type: "share_with_family", title: "Send the shortlist to the family for review", dueDate: () => daysFromNow(2) }],
  INTRODUCTION: [{ type: "schedule_introduction", title: "Schedule an introduction", dueDate: () => daysFromNow(5) }],
};

// spec §17's exact checklist.
const MOVE_IN_CHECKLIST_ITEMS = [
  "Move-in date confirmed",
  "Provider confirmed",
  "Family notified",
  "Required documents complete",
  "Transportation arranged if applicable",
  "Final details confirmed",
];

// spec §19 — completing one creates the next (see advanceFollowup).
const FOLLOWUP_SEQUENCE = [
  { type: "followup_48h", title: "48-hour check-in", offsetDays: 2 },
  { type: "followup_7d", title: "7-day check-in", offsetDays: 7 },
  { type: "followup_30d", title: "30-day check-in", offsetDays: 30 },
];

async function createTaskIfMissing(placementId, type, data) {
  const existing = await prisma.placementTask.findFirst({ where: { placementId, type } });
  if (existing) return existing;
  return prisma.placementTask.create({ data: { placementId, type, ...data } });
}

// Called after every stage transition (same call site as recordTransition).
async function createTasksForStage(placementId, stage, { assignedToId } = {}) {
  const templates = STAGE_TASKS[stage];
  if (templates) {
    for (const t of templates) {
      await createTaskIfMissing(placementId, t.type, { title: t.title, dueDate: t.dueDate(), assignedToId: assignedToId || null });
    }
  }

  if (stage === "CONFIRMED") {
    const existing = await prisma.placementTask.count({ where: { placementId, type: "move_in_checklist" } });
    if (existing === 0) {
      await prisma.placementTask.createMany({
        data: MOVE_IN_CHECKLIST_ITEMS.map((title) => ({ placementId, type: "move_in_checklist", title, assignedToId: assignedToId || null })),
      });
    }
  }
}

// Called when a placement actually becomes ACTIVE (a real move-in date has
// arrived) — creates the first follow-up; completing it creates the next.
async function createFirstFollowup(placementId, moveInDate, { assignedToId } = {}) {
  const first = FOLLOWUP_SEQUENCE[0];
  await createTaskIfMissing(placementId, first.type, {
    title: first.title,
    dueDate: new Date(new Date(moveInDate).getTime() + first.offsetDays * 24 * 60 * 60 * 1000),
    assignedToId: assignedToId || null,
  });
}

// Called when a follow-up task is marked complete — creates the next one
// in the sequence, if there is one and it doesn't already exist.
async function advanceFollowup(task, moveInDate) {
  const index = FOLLOWUP_SEQUENCE.findIndex((f) => f.type === task.type);
  if (index === -1 || index === FOLLOWUP_SEQUENCE.length - 1) return null;
  const next = FOLLOWUP_SEQUENCE[index + 1];
  return createTaskIfMissing(task.placementId, next.type, {
    title: next.title,
    dueDate: new Date(new Date(moveInDate).getTime() + next.offsetDays * 24 * 60 * 60 * 1000),
    assignedToId: task.assignedToId,
  });
}

// Status is computed, never stored — same convention as
// EmployeeOnboardingItem, the closest existing checklist engine.
function withStatus(task) {
  const now = new Date();
  let status;
  if (task.completedAt) status = "done";
  else if (task.dueDate && new Date(task.dueDate) < now) status = "overdue";
  else status = "pending";
  return { ...task, status };
}

module.exports = { createTasksForStage, createFirstFollowup, advanceFollowup, withStatus, FOLLOWUP_SEQUENCE };
