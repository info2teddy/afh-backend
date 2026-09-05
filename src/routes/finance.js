// src/routes/finance.js
// The one aggregate view combining revenue (invoices), payroll (payroll
// runs), and expenses (this business's own capture) into a single monthly
// snapshot — the "how is my AFH doing this month" question from the brief.
// Deliberately not a full P&L: no accruals, no balance sheet, no tax
// treatment. That's QuickBooks' job.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

function monthRange(monthStr) {
  const [year, mo] = monthStr.split("-").map(Number);
  return { start: new Date(Date.UTC(year, mo - 1, 1)), end: new Date(Date.UTC(year, mo, 1)) };
}

router.get("/overview", async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { start, end } = monthRange(month);

  const [invoices, payrollRuns, expenses] = await Promise.all([
    prisma.invoice.findMany({
      where: { tenantId: req.tenantId, billingPeriodStart: { gte: start, lt: end } },
      select: { totalAmount: true },
    }),
    prisma.payrollRun.findMany({
      where: { tenantId: req.tenantId, payPeriodStart: { gte: start, lt: end } },
      select: { totalGrossPay: true },
    }),
    prisma.expense.findMany({
      where: { tenantId: req.tenantId, date: { gte: start, lt: end } },
      select: { amount: true, category: true },
    }),
  ]);

  const revenue = invoices.reduce((sum, i) => sum + Number(i.totalAmount), 0);
  const payroll = payrollRuns.reduce((sum, p) => sum + Number(p.totalGrossPay || 0), 0);
  const expenseTotal = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

  const byCategory = {};
  for (const e of expenses) {
    byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount);
  }

  res.json({
    month,
    revenue,
    payroll,
    expenses: expenseTotal,
    expensesByCategory: Object.entries(byCategory)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
    netIncome: revenue - payroll - expenseTotal,
  });
});

module.exports = router;
