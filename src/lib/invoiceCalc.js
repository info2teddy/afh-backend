// src/lib/invoiceCalc.js
// The billing math behind POST /invoices/generate, kept free of the database
// so it can be tested directly (test/invoiceCalc.test.js).

const DAY_MS = 86400000;

// resident: { payerType, medicaidSplitPct, moveInDate, moveOutDate }
// rate:     { roomAndBoardRate, monthlyRate }  (the schedule in effect for the period)
// start/end: Dates for the first and last day of the billing period (both included)
function computeInvoice(resident, rate, start, end) {
  const daysInPeriod = Math.round((end - start) / DAY_MS) + 1;

  // Proration: how many of those days the resident actually lived there.
  // Move-in and move-out days both count as days present.
  const effectiveStart = resident.moveInDate > start ? resident.moveInDate : start;
  const effectiveEnd = resident.moveOutDate && resident.moveOutDate < end ? resident.moveOutDate : end;
  const daysPresent = Math.max(Math.round((effectiveEnd - effectiveStart) / DAY_MS) + 1, 0);

  const baseMonthly = Number(rate.roomAndBoardRate) + Number(rate.monthlyRate);
  const total = round2(baseMonthly * (daysPresent / daysInPeriod));

  const lineItems = [];
  if (resident.payerType === "private_pay") {
    lineItems.push({ description: "Room & board and care charges (private pay)", amount: total, lineType: "private_pay_portion" });
  } else if (resident.payerType === "medicaid") {
    lineItems.push({ description: "Room & board and care charges (Medicaid)", amount: total, lineType: "medicaid_portion" });
  } else {
    // Split: the private share is whatever's left after rounding the Medicaid
    // share, so the lines always add up to the total to the cent.
    const medicaidAmt = round2(total * (Number(resident.medicaidSplitPct) / 100));
    const privateAmt = round2(total - medicaidAmt);
    lineItems.push({ description: `Medicaid portion (${resident.medicaidSplitPct}%)`, amount: medicaidAmt, lineType: "medicaid_portion" });
    lineItems.push({ description: `Private pay portion (${100 - Number(resident.medicaidSplitPct)}%)`, amount: privateAmt, lineType: "private_pay_portion" });
  }

  return { daysInPeriod, daysPresent, total, lineItems };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { computeInvoice };
