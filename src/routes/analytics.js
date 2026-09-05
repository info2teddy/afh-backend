// src/routes/analytics.js
// Cross-facility trends, built on top of the same real records finance.js
// already aggregates for a single month — revenue (invoices), payroll (payroll
// runs), expenses — plus a current occupancy/census snapshot from residents.
// No projections, no benchmarks against other AFHs: just this tenant's own
// history, which is honestly thin for a business this new.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [year, mo] = key.split("-").map(Number);
  return new Date(Date.UTC(year, mo - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// GET /analytics/overview?months=6 — trailing N months (default 6, capped at 12)
// of revenue/expenses/payroll, plus today's occupancy and resident census.
router.get("/overview", async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 12);
  const now = new Date();
  const rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const [invoices, payrollRuns, expenses, homes, activeResidents] = await Promise.all([
    prisma.invoice.findMany({
      where: { tenantId: req.tenantId, billingPeriodStart: { gte: rangeStart } },
      select: { totalAmount: true, billingPeriodStart: true },
    }),
    prisma.payrollRun.findMany({
      where: { tenantId: req.tenantId, payPeriodStart: { gte: rangeStart } },
      select: { totalGrossPay: true, payPeriodStart: true },
    }),
    prisma.expense.findMany({
      where: { tenantId: req.tenantId, date: { gte: rangeStart } },
      select: { amount: true, date: true },
    }),
    prisma.home.findMany({
      where: { tenantId: req.tenantId },
      select: { id: true, name: true, capacity: true },
    }),
    prisma.resident.findMany({
      where: { tenantId: req.tenantId, status: "active" },
      select: { homeId: true, careLevel: true, payerType: true },
    }),
  ]);

  const buckets = new Map();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - i), 1));
    const key = monthKey(d);
    buckets.set(key, { month: key, label: monthLabel(key), revenue: 0, expenses: 0, payroll: 0 });
  }

  for (const inv of invoices) {
    const key = monthKey(inv.billingPeriodStart);
    if (buckets.has(key)) buckets.get(key).revenue += Number(inv.totalAmount);
  }
  for (const run of payrollRuns) {
    const key = monthKey(run.payPeriodStart);
    if (buckets.has(key)) buckets.get(key).payroll += Number(run.totalGrossPay || 0);
  }
  for (const exp of expenses) {
    const key = monthKey(exp.date);
    if (buckets.has(key)) buckets.get(key).expenses += Number(exp.amount);
  }

  const trend = Array.from(buckets.values()).map((b) => ({ ...b, netIncome: b.revenue - b.expenses - b.payroll }));

  const residentsByHome = new Map();
  const byCareLevel = new Map();
  const byPayerType = new Map();
  for (const r of activeResidents) {
    residentsByHome.set(r.homeId, (residentsByHome.get(r.homeId) || 0) + 1);
    byCareLevel.set(r.careLevel, (byCareLevel.get(r.careLevel) || 0) + 1);
    byPayerType.set(r.payerType, (byPayerType.get(r.payerType) || 0) + 1);
  }

  const occupancy = homes.map((h) => {
    const occupied = residentsByHome.get(h.id) || 0;
    return {
      homeId: h.id,
      homeName: h.name,
      capacity: h.capacity,
      occupied,
      occupancyPct: h.capacity > 0 ? Math.round((occupied / h.capacity) * 100) : 0,
    };
  });

  res.json({
    trend,
    occupancy,
    census: {
      byCareLevel: Array.from(byCareLevel, ([careLevel, count]) => ({ careLevel, count })),
      byPayerType: Array.from(byPayerType, ([payerType, count]) => ({ payerType, count })),
    },
  });
});

module.exports = router;
