// Billing math: proration and payer splits. Run with `npm test`.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeInvoice } = require("../src/lib/invoiceCalc");

const d = (s) => new Date(s);
const rate = { roomAndBoardRate: "1500.00", monthlyRate: "4500.00" }; // $6,000/month, strings like Prisma Decimals
const resident = (extra) => ({ payerType: "private_pay", medicaidSplitPct: null, moveInDate: d("2026-01-01"), moveOutDate: null, ...extra });
const sum = (items) => Math.round(items.reduce((a, li) => a + li.amount, 0) * 100) / 100;

test("a full month is billed in full", () => {
  const r = computeInvoice(resident(), rate, d("2026-09-01"), d("2026-09-30"));
  assert.equal(r.daysInPeriod, 30);
  assert.equal(r.daysPresent, 30);
  assert.equal(r.total, 6000);
  assert.deepEqual(r.lineItems.map((li) => li.lineType), ["private_pay_portion"]);
});

test("mid-month move-in is prorated, counting the move-in day", () => {
  const r = computeInvoice(resident({ moveInDate: d("2026-09-16") }), rate, d("2026-09-01"), d("2026-09-30"));
  assert.equal(r.daysPresent, 15);
  assert.equal(r.total, 3000);
});

test("mid-month move-out is prorated, counting the move-out day", () => {
  const r = computeInvoice(resident({ moveOutDate: d("2026-09-10") }), rate, d("2026-09-01"), d("2026-09-30"));
  assert.equal(r.daysPresent, 10);
  assert.equal(r.total, 2000);
});

test("31-day and 28-day months prorate by their own length", () => {
  assert.equal(computeInvoice(resident({ moveInDate: d("2026-10-31") }), rate, d("2026-10-01"), d("2026-10-31")).total, 193.55);
  assert.equal(computeInvoice(resident({ moveInDate: d("2026-02-15") }), rate, d("2026-02-01"), d("2026-02-28")).total, 3000);
});

test("a resident not there at all that month owes nothing", () => {
  const r = computeInvoice(resident({ moveOutDate: d("2026-08-20") }), rate, d("2026-09-01"), d("2026-09-30"));
  assert.equal(r.daysPresent, 0);
  assert.equal(r.total, 0);
});

test("Medicaid residents get one Medicaid line", () => {
  const r = computeInvoice(resident({ payerType: "medicaid" }), rate, d("2026-09-01"), d("2026-09-30"));
  assert.deepEqual(r.lineItems.map((li) => [li.lineType, li.amount]), [["medicaid_portion", 6000]]);
});

test("split payers: lines add up to the total to the cent, even with awkward percentages", () => {
  for (const pct of ["70", "33.33", "66.67", "12.5"]) {
    for (const moveIn of ["2026-09-01", "2026-09-07", "2026-09-29"]) {
      const r = computeInvoice(resident({ payerType: "split", medicaidSplitPct: pct, moveInDate: d(moveIn) }), rate, d("2026-09-01"), d("2026-09-30"));
      assert.equal(sum(r.lineItems), r.total, `${pct}% from ${moveIn}`);
    }
  }
  const r = computeInvoice(resident({ payerType: "split", medicaidSplitPct: "70" }), rate, d("2026-09-01"), d("2026-09-30"));
  assert.deepEqual(r.lineItems.map((li) => [li.lineType, li.amount]), [["medicaid_portion", 4200], ["private_pay_portion", 1800]]);
});
