// src/routes/expenses.js
// Operating expense capture — see the Expense model comment for why this
// isn't "accounting." Receipt scanning reuses the same
// upload-then-ask-Claude pattern as care plan document generation.

const express = require("express");
const multer = require("multer");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5";

const ACCEPTED_RECEIPT_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ACCEPTED_RECEIPT_TYPES.has(file.mimetype)) {
      return cb(new Error("Only PDF or image (PNG/JPEG/WEBP) files are supported."));
    }
    cb(null, true);
  },
});

const EXPENSE_SELECT = {
  id: true,
  homeId: true,
  date: true,
  category: true,
  vendor: true,
  amount: true,
  paymentMethod: true,
  notes: true,
  receiptName: true,
  qboSynced: true,
  createdAt: true,
  home: { select: { name: true } },
  // receiptData deliberately excluded — see GET /:id/receipt
};

// GET /expenses?month=YYYY-MM&homeId=... — list expenses for the tenant
router.get("/", async (req, res) => {
  const { month, homeId } = req.query;
  const where = { tenantId: req.tenantId };
  if (homeId) where.homeId = homeId;
  if (month) {
    const [year, mo] = month.split("-").map(Number);
    where.date = { gte: new Date(Date.UTC(year, mo - 1, 1)), lt: new Date(Date.UTC(year, mo, 1)) };
  }

  const expenses = await prisma.expense.findMany({
    where,
    select: EXPENSE_SELECT,
    orderBy: { date: "desc" },
  });
  res.json(expenses);
});

// POST /expenses — create an expense, optionally with a receipt file
router.post("/", upload.single("receipt"), async (req, res) => {
  const { homeId, date, category, vendor, amount, paymentMethod, notes } = req.body;
  if (!homeId || !date || !category || !amount) {
    return res.status(400).json({ error: "homeId, date, category, and amount are required." });
  }

  const home = await prisma.home.findFirst({ where: { id: homeId, tenantId: req.tenantId } });
  if (!home) return res.status(404).json({ error: "Home not found for this tenant." });

  const file = req.file;
  const expense = await prisma.expense.create({
    data: {
      tenantId: req.tenantId,
      homeId,
      date: new Date(date),
      category,
      vendor: vendor || null,
      amount: Number(amount),
      paymentMethod: paymentMethod || null,
      notes: notes || null,
      receiptName: file?.originalname || null,
      receiptMimeType: file?.mimetype || null,
      receiptData: file?.buffer || null,
    },
    select: EXPENSE_SELECT,
  });
  res.status(201).json(expense);
});

// GET /expenses/:id/receipt — the raw uploaded receipt file
router.get("/:id/receipt", async (req, res) => {
  const expense = await prisma.expense.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
    select: { receiptName: true, receiptMimeType: true, receiptData: true },
  });
  if (!expense || !expense.receiptData) {
    return res.status(404).json({ error: "No receipt found for this expense." });
  }
  res.set("Content-Type", expense.receiptMimeType || "application/octet-stream");
  res.set("Content-Disposition", `inline; filename="${expense.receiptName || "receipt"}"`);
  res.send(expense.receiptData);
});

const EXPENSE_CATEGORIES = ["Food & Supplies", "Rent", "Utilities", "Medical Supplies", "Insurance", "Other"];

// POST /expenses/extract-receipt — AI-assisted prefill, doesn't save anything.
// The frontend shows the extracted fields for the user to review/edit before
// submitting the real POST /expenses.
router.post("/extract-receipt", upload.single("receipt"), async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "AI provider not configured — set ANTHROPIC_API_KEY on the backend." });
  }
  const file = req.file;
  if (!file) return res.status(400).json({ error: "A receipt file is required." });
  if (file.mimetype === "application/pdf") {
    return res.status(400).json({ error: "Receipt scanning supports images only, not PDF." });
  }

  const prompt = `Extract structured data from this receipt image. Respond with ONLY a JSON object, no markdown, no explanation, in exactly this shape:
{"vendor": string or null, "date": "YYYY-MM-DD" or null, "amount": number or null, "category": one of ${JSON.stringify(EXPENSE_CATEGORIES)}}

If a field isn't legible or present, use null for it (except category — pick your best guess, defaulting to "Other"). Today's date is ${new Date().toISOString().slice(0, 10)}, for resolving relative or ambiguous years.`;

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
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image", source: { type: "base64", media_type: file.mimetype, data: file.buffer.toString("base64") } },
            ],
          },
        ],
      }),
    });
    if (!aiRes.ok) {
      const errBody = await aiRes.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `AI provider returned ${aiRes.status}`);
    }
    const aiBody = await aiRes.json();
    const text = aiBody.content?.[0]?.text;
    if (!text) throw new Error("AI provider returned an empty response.");

    // Claude sometimes wraps JSON in a markdown fence despite instructions.
    const cleaned = text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const extracted = JSON.parse(cleaned);
    res.json(extracted);
  } catch (err) {
    res.status(502).json({ error: `Receipt scan failed: ${err.message}` });
  }
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes("PDF or image")) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
