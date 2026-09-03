// src/routes/carePlans.js
// AI-drafted, date-specific care plans. Runs AFTER resolveTenant, so
// req.tenantId is already trusted — every query below is scoped to it.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5";

function buildPrompt(resident, planDate) {
  const dateLabel = new Date(planDate).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `You are drafting a daily care plan for a resident of a licensed Adult Family Home (AFH) in Washington State. This is a DRAFT for a caregiver to review, edit, and sign off on — not a substitute for clinical judgment.

Resident: ${resident.name}
Care level: ${resident.careLevel}
Payer type: ${resident.payerType}
Move-in date: ${new Date(resident.moveInDate).toLocaleDateString()}
Plan date: ${dateLabel}

Write a concise, practical care plan for this specific date, covering:
1. Activities of Daily Living (ADL) support appropriate to the care level (bathing, dressing, mobility, toileting)
2. A medication/health-check reminder schedule (generic placeholders like "morning medications," "vitals check" — do not invent specific drug names or dosages, since none were provided)
3. Nutrition/meal notes
4. Safety and mobility considerations
5. Social/emotional engagement for the day

Format as short labeled sections with bullet points. Keep it under 300 words. Do not fabricate specific medical diagnoses, medications, or allergies — flag where the caregiver should fill in resident-specific clinical details you don't have.`;
}

router.get("/", async (req, res) => {
  const { residentId } = req.query;
  if (!residentId) {
    return res.status(400).json({ error: "residentId is required." });
  }
  const plans = await prisma.carePlan.findMany({
    where: { tenantId: req.tenantId, residentId },
    orderBy: { planDate: "desc" },
  });
  res.json(plans);
});

router.post("/generate", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: "AI provider not configured — set ANTHROPIC_API_KEY on the backend to enable care plan generation.",
    });
  }

  const { residentId, planDate } = req.body;
  if (!residentId || !planDate) {
    return res.status(400).json({ error: "residentId and planDate are required." });
  }

  const resident = await prisma.resident.findFirst({
    where: { id: residentId, tenantId: req.tenantId },
  });
  if (!resident) {
    return res.status(404).json({ error: "Resident not found." });
  }

  let content;
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
        max_tokens: 1024,
        messages: [{ role: "user", content: buildPrompt(resident, planDate) }],
      }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `AI provider returned ${aiRes.status}`);
    }

    const aiBody = await aiRes.json();
    content = aiBody.content?.[0]?.text;
    if (!content) throw new Error("AI provider returned an empty response.");
  } catch (err) {
    return res.status(502).json({ error: `Care plan generation failed: ${err.message}` });
  }

  const plan = await prisma.carePlan.create({
    data: {
      tenantId: req.tenantId,
      residentId,
      planDate: new Date(planDate),
      content,
      model: MODEL,
    },
  });

  res.status(201).json(plan);
});

module.exports = router;
