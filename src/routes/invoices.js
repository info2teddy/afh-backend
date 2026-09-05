// src/routes/invoices.js
const express = require("express");
const { prisma } = require("../middleware/tenant");
const { getValidAccessToken } = require("../lib/quickbooksAuth");
const { pushInvoice } = require("../lib/quickbooksClient");
const router = express.Router();

// GET /invoices?residentId=... — list invoices, optionally filtered by resident
router.get("/", async (req, res) => {
  const where = { tenantId: req.tenantId };
  if (req.query.residentId) where.residentId = req.query.residentId;

  const invoices = await prisma.invoice.findMany({
    where,
    include: { lineItems: true, resident: { select: { name: true } } },
    orderBy: { billingPeriodStart: "desc" },
  });
  res.json(invoices);
});

// POST /invoices/generate — generate an invoice for one resident for a billing period
// body: { residentId, periodStart: "2026-08-01", periodEnd: "2026-08-31" }
router.post("/generate", async (req, res) => {
  const { residentId, periodStart, periodEnd } = req.body;
  if (!residentId || !periodStart || !periodEnd) {
    return res.status(400).json({ error: "residentId, periodStart, and periodEnd are required." });
  }

  const resident = await prisma.resident.findFirst({
    where: { id: residentId, tenantId: req.tenantId },
  });
  if (!resident) return res.status(404).json({ error: "Resident not found." });

  const existingInvoice = await prisma.invoice.findFirst({
    where: { residentId, billingPeriodStart: new Date(periodStart) },
  });
  if (existingInvoice) {
    return res.status(409).json({ error: "An invoice already exists for this resident and billing period." });
  }

  const rate = await prisma.rateSchedule.findFirst({
    where: {
      tenantId: req.tenantId,
      homeId: resident.homeId,
      careLevel: resident.careLevel,
      effectiveDate: { lte: new Date(periodStart) }, // only rates in effect AT the billing period —
      // without this filter, entering a future rate change (e.g. pre-scheduling
      // next quarter's increase) would silently apply it to past-period invoices too.
    },
    orderBy: { effectiveDate: "desc" },
  });
  if (!rate) return res.status(400).json({ error: "No rate schedule found for this resident's care level." });

  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  const daysInPeriod = Math.round((end - start) / 86400000) + 1;

  // Proration: how many of those days did the resident actually live there
  const effectiveStart = resident.moveInDate > start ? resident.moveInDate : start;
  const effectiveEnd = resident.moveOutDate && resident.moveOutDate < end ? resident.moveOutDate : end;
  const daysPresent = Math.max(Math.round((effectiveEnd - effectiveStart) / 86400000) + 1, 0);

  const baseMonthly = Number(rate.roomAndBoardRate) + Number(rate.monthlyRate);
  const proratedTotal = round2(baseMonthly * (daysPresent / daysInPeriod));

  const lineItems = [];
  if (resident.payerType === "private_pay") {
    lineItems.push({ description: "Room & board and care charges (private pay)", amount: proratedTotal, lineType: "private_pay_portion" });
  } else if (resident.payerType === "medicaid") {
    lineItems.push({ description: "Room & board and care charges (Medicaid)", amount: proratedTotal, lineType: "medicaid_portion" });
  } else {
    const medicaidPct = Number(resident.medicaidSplitPct) / 100;
    const medicaidAmt = round2(proratedTotal * medicaidPct);
    const privateAmt = round2(proratedTotal - medicaidAmt);
    lineItems.push({ description: `Medicaid portion (${resident.medicaidSplitPct}%)`, amount: medicaidAmt, lineType: "medicaid_portion" });
    lineItems.push({ description: `Private pay portion (${100 - Number(resident.medicaidSplitPct)}%)`, amount: privateAmt, lineType: "private_pay_portion" });
  }

  const invoice = await prisma.invoice.create({
    data: {
      tenantId: req.tenantId,
      residentId,
      billingPeriodStart: start,
      billingPeriodEnd: end,
      totalAmount: proratedTotal,
      status: "draft",
      lineItems: { create: lineItems },
    },
    include: { lineItems: true },
  });

  res.status(201).json(invoice);
});

// PATCH /invoices/:id/qbo-sync — record the QuickBooks IDs once pushed
router.patch("/:id/qbo-sync", async (req, res) => {
  const { qboInvoiceId, qboSyncToken } = req.body;

  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!invoice) return res.status(404).json({ error: "Invoice not found." });

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { qboInvoiceId, qboSyncToken, status: "sent" },
  });
  res.json(updated);
});

// PATCH /invoices/:id/push-to-quickbooks — pushes the invoice to the tenant's own
// QuickBooks account. Called from the "Push to QuickBooks" button on the invoice screen.
router.patch("/:id/push-to-quickbooks", async (req, res) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
    include: { lineItems: true, resident: { include: { home: true } } },
  });
  if (!invoice) return res.status(404).json({ error: "Invoice not found." });
  if (!invoice.resident.qboCustomerId) {
    return res.status(400).json({ error: "Resident has no linked QuickBooks customer — set one up first." });
  }

  const revenueItemMap = req.tenant.qboRevenueItemMap || {};
  const unmappedLineTypes = [...new Set(invoice.lineItems.map((li) => li.lineType).filter((t) => !revenueItemMap[t]))];
  if (unmappedLineTypes.length > 0) {
    return res.status(400).json({
      error: `Map ${unmappedLineTypes.join(", ")} to a QuickBooks item in Settings → QuickBooks before pushing this invoice.`,
    });
  }

  try {
    const { qboInvoiceId, qboSyncToken } = await pushInvoice(
      req.tenant.quickbooksRealmId,
      () => getValidAccessToken(req.tenantId),
      {
        qboCustomerId: invoice.resident.qboCustomerId,
        periodStart: invoice.billingPeriodStart.toISOString().slice(0, 10),
        internalInvoiceId: invoice.id,
        qboLocationId: invoice.resident.home.qboLocationId,
        lineItems: invoice.lineItems.map((li) => ({
          description: li.description,
          amount: Number(li.amount),
          qboItemId: revenueItemMap[li.lineType].itemId,
        })),
      }
    );

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { qboInvoiceId, qboSyncToken, status: "sent" },
    });
    res.json(updated);
  } catch (err) {
    console.error(`QuickBooks push failed for invoice ${invoice.id}:`, err);
    res.status(502).json({ error: "Could not push invoice to QuickBooks. Try again shortly." });
  }
});

// DELETE /invoices/:id — draft only. Once an invoice has been sent or pushed
// to QuickBooks it's a real record elsewhere and shouldn't just disappear;
// draft is the only status that's still purely internal.
router.delete("/:id", async (req, res) => {
  const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!invoice) return res.status(404).json({ error: "Invoice not found." });
  if (invoice.status !== "draft") {
    return res.status(400).json({ error: `Only draft invoices can be deleted (this one is ${invoice.status}).` });
  }
  await prisma.invoice.delete({ where: { id: invoice.id } });
  res.status(204).end();
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = router;
