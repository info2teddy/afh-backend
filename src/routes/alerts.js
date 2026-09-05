// src/routes/alerts.js
// Cross-cutting "what needs attention" alerts, gathered server-side in one
// pass so the Dashboard doesn't have to make a dozen round trips (or, worse,
// N+1 one per resident). Every alert is a real condition already queryable
// elsewhere in the app (credentials, care plans, onboarding, assessments,
// shift approvals) — this just surfaces them together.
//
// The optional `summary` field is AI-written, but only ever summarizes the
// exact alert list computed below — the prompt hands it that list as its
// only input and tells it not to invent anything beyond it. If there are no
// alerts, or no API key configured, summary is null rather than faked.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5";

const todayUTC = () => new Date(new Date().toISOString().slice(0, 10));
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

router.get("/", async (req, res) => {
  const today = todayUTC();
  const assessmentCutoff = addDays(today, 14);
  const unapprovedShiftCutoff = addDays(today, -3); // clocked out 3+ days ago, still unapproved

  const [expiringCredentials, activeResidents, todaysCarePlans, overdueOnboarding, unapprovedShifts] =
    await Promise.all([
      prisma.credential.findMany({
        where: { tenantId: req.tenantId, expirationDate: { lte: addDays(today, 90) } },
        include: { employee: { select: { name: true } } },
        orderBy: { expirationDate: "asc" },
      }),
      prisma.resident.findMany({
        where: { tenantId: req.tenantId, status: "active" },
        select: { id: true, name: true, nextAssessmentDate: true },
      }),
      prisma.carePlan.findMany({
        where: { tenantId: req.tenantId, planDate: { gte: today, lt: addDays(today, 1) } },
        select: { residentId: true },
      }),
      prisma.employeeOnboardingItem.findMany({
        where: { tenantId: req.tenantId, completedAt: null, dueDate: { lt: today } },
        include: { employee: { select: { name: true } }, template: { select: { name: true } } },
      }),
      prisma.shift.findMany({
        where: { tenantId: req.tenantId, approved: false, clockOut: { not: null, lt: unapprovedShiftCutoff } },
        select: { id: true },
      }),
    ]);

  const alerts = [];

  const criticalCredentials = expiringCredentials.filter((c) => new Date(c.expirationDate) <= addDays(today, 30));
  const upcomingCredentials = expiringCredentials.filter((c) => new Date(c.expirationDate) > addDays(today, 30));
  if (criticalCredentials.length > 0) {
    alerts.push({
      type: "credential_expiring",
      tone: "danger",
      message: `${criticalCredentials.length} credential${criticalCredentials.length === 1 ? "" : "s"} expired or expiring within 30 days`,
      link: "/credentials",
      count: criticalCredentials.length,
    });
  }
  if (upcomingCredentials.length > 0) {
    alerts.push({
      type: "credential_expiring",
      tone: "warning",
      message: `${upcomingCredentials.length} credential${upcomingCredentials.length === 1 ? "" : "s"} expiring in the next 31–90 days`,
      link: "/credentials",
      count: upcomingCredentials.length,
    });
  }

  const planned = new Set(todaysCarePlans.map((p) => p.residentId));
  const residentsNeedingPlan = activeResidents.filter((r) => !planned.has(r.id));
  if (residentsNeedingPlan.length > 0) {
    alerts.push({
      type: "care_plan_missing",
      tone: "warning",
      message: `${residentsNeedingPlan.length} resident${residentsNeedingPlan.length === 1 ? "" : "s"} missing today's care plan`,
      link: "/care-plan",
      count: residentsNeedingPlan.length,
    });
  }

  const overdueAssessments = activeResidents.filter(
    (r) => r.nextAssessmentDate && new Date(r.nextAssessmentDate) < today
  );
  const upcomingAssessments = activeResidents.filter(
    (r) => r.nextAssessmentDate && new Date(r.nextAssessmentDate) >= today && new Date(r.nextAssessmentDate) <= assessmentCutoff
  );
  if (overdueAssessments.length > 0) {
    alerts.push({
      type: "assessment_due",
      tone: "danger",
      message: `${overdueAssessments.length} resident${overdueAssessments.length === 1 ? "" : "s"} past their next assessment date`,
      link: "/residents",
      count: overdueAssessments.length,
    });
  }
  if (upcomingAssessments.length > 0) {
    alerts.push({
      type: "assessment_due",
      tone: "warning",
      message: `${upcomingAssessments.length} resident${upcomingAssessments.length === 1 ? "" : "s"} due for reassessment within 14 days`,
      link: "/residents",
      count: upcomingAssessments.length,
    });
  }

  if (overdueOnboarding.length > 0) {
    alerts.push({
      type: "onboarding_overdue",
      tone: "danger",
      message: `${overdueOnboarding.length} onboarding item${overdueOnboarding.length === 1 ? "" : "s"} past due`,
      link: "/onboarding",
      count: overdueOnboarding.length,
    });
  }

  if (unapprovedShifts.length > 0) {
    alerts.push({
      type: "shift_unapproved",
      tone: "warning",
      message: `${unapprovedShifts.length} shift${unapprovedShifts.length === 1 ? "" : "s"} clocked out 3+ days ago still unapproved`,
      link: "/timekeeping",
      count: unapprovedShifts.length,
    });
  }

  const summary = await summarize(alerts);
  res.json({ alerts, summary });
});

async function summarize(alerts) {
  if (!ANTHROPIC_API_KEY || alerts.length === 0) return null;

  const prompt = `You write a one-sentence operations summary for the owner of a small licensed adult family home business. Below is the exact, complete list of current alerts as JSON — every item in it is real and already verified. Do not mention, imply, or invent anything beyond what's in this list; do not add caveats about data you don't have. Pick the most urgent 1-2 items (danger before warning) and write a single plain sentence (no markdown) telling the owner what to look at first.

${JSON.stringify(alerts.map((a) => ({ tone: a.tone, message: a.message })))}`;

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 150,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!aiRes.ok) return null;
    const body = await aiRes.json();
    return body.content?.[0]?.text?.trim() || null;
  } catch {
    return null; // the alert list itself still renders fine without a summary
  }
}

module.exports = router;
