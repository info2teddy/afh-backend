// src/lib/expenseConstants.js
// Shared between expenses.js (validation) and quickbooksConnect.js (the
// category/payment-account mapping UI) so the two lists can't drift apart.

const EXPENSE_CATEGORIES = ["Food & Supplies", "Rent", "Utilities", "Medical Supplies", "Insurance", "Other"];
const PAYMENT_METHODS = ["business_card", "check", "cash", "other"];

module.exports = { EXPENSE_CATEGORIES, PAYMENT_METHODS };
