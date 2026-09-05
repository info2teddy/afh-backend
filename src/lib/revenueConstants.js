// src/lib/revenueConstants.js
// The two invoice line types invoices.js's /generate route actually
// produces (see its payerType branches) — shared with quickbooksConnect.js's
// revenue-item mapping UI so the two lists can't drift apart.
const REVENUE_LINE_TYPES = ["private_pay_portion", "medicaid_portion"];

module.exports = { REVENUE_LINE_TYPES };
