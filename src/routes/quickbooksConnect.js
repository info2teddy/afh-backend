// src/routes/quickbooksConnect.js
// The one-time "Connect QuickBooks" flow for a tenant. Distinct from
// quickbooksAuth.js, which only handles refreshing an ALREADY-connected tenant's
// access token, and from quickbooksCallback.js, which handles Intuit's redirect
// back (that one runs BEFORE tenant resolution — see app.js for why).

const express = require("express");
const { prisma } = require("../middleware/tenant");
const { getValidAccessToken } = require("../lib/quickbooksAuth");
const { fetchAccounts, fetchItems } = require("../lib/quickbooksClient");
const { EXPENSE_CATEGORIES, PAYMENT_METHODS } = require("../lib/expenseConstants");
const { REVENUE_LINE_TYPES } = require("../lib/revenueConstants");
const router = express.Router();

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID;
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI; // e.g. https://yourapp.com/quickbooks/callback
const QBO_AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";

// Account types that make sense as an expense-category target vs. a
// payment-source target — QBO's chart of accounts mixes both together.
const EXPENSE_ACCOUNT_TYPES = new Set(["Expense", "Other Expense", "Cost of Goods Sold"]);
const PAYMENT_ACCOUNT_TYPES = new Set(["Bank", "Credit Card"]);

// GET /quickbooks/connect — the "Connect QuickBooks" button in the client's
// settings screen hits this. req.tenantId is already resolved by the tenant
// middleware, and gets encoded into `state` so the callback knows which
// tenant to attach the tokens to.
//
// Returns the Intuit auth URL as JSON rather than issuing a redirect itself:
// this route requires the same Bearer-token auth as the rest of the API, and
// a plain browser navigation (an <a href>) can't attach that header. The
// frontend fetches this, then navigates a new tab to the URL it gets back.
router.get("/connect", (req, res) => {
  const state = Buffer.from(JSON.stringify({ tenantId: req.tenantId, nonce: randomNonce() })).toString("base64url");

  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    redirect_uri: QBO_REDIRECT_URI,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    state,
  });
  res.json({ url: `${QBO_AUTH_BASE}?${params.toString()}` });
});

// GET /quickbooks/status — whether the current tenant has completed the
// QuickBooks OAuth flow, for the Settings screen to reflect.
router.get("/status", (req, res) => {
  res.json({ connected: !!req.tenant.quickbooksRealmId });
});

// GET /quickbooks/accounts — this tenant's QuickBooks chart of accounts,
// split into expense accounts (candidates for category mapping) and
// bank/credit-card accounts (candidates for payment-method mapping), for the
// Settings → QuickBooks mapping UI to populate its dropdowns from.
router.get("/accounts", async (req, res) => {
  if (!req.tenant.quickbooksRealmId) {
    return res.status(400).json({ error: "Connect QuickBooks first." });
  }
  try {
    const accounts = await fetchAccounts(req.tenant.quickbooksRealmId, () => getValidAccessToken(req.tenantId));
    res.json({
      expenseAccounts: accounts
        .filter((a) => EXPENSE_ACCOUNT_TYPES.has(a.AccountType))
        .map((a) => ({ id: a.Id, name: a.Name })),
      paymentAccounts: accounts
        .filter((a) => PAYMENT_ACCOUNT_TYPES.has(a.AccountType))
        .map((a) => ({ id: a.Id, name: a.Name, accountType: a.AccountType })),
    });
  } catch (err) {
    console.error("Failed to fetch QuickBooks accounts:", err);
    res.status(502).json({ error: "Could not load QuickBooks accounts. Try again shortly." });
  }
});

// GET /quickbooks/items — this tenant's QuickBooks sales items, for the
// revenue line-type mapping UI to populate its dropdowns from.
router.get("/items", async (req, res) => {
  if (!req.tenant.quickbooksRealmId) {
    return res.status(400).json({ error: "Connect QuickBooks first." });
  }
  try {
    const items = await fetchItems(req.tenant.quickbooksRealmId, () => getValidAccessToken(req.tenantId));
    res.json({ items: items.map((i) => ({ id: i.Id, name: i.Name, type: i.Type })) });
  } catch (err) {
    console.error("Failed to fetch QuickBooks items:", err);
    res.status(502).json({ error: "Could not load QuickBooks items. Try again shortly." });
  }
});

// GET /quickbooks/mappings — this tenant's expense-category → account,
// payment-method → account, and revenue-line-type → item mappings,
// alongside the fixed lists the app supports, so the UI can render one row
// per category/method/line-type regardless of what's already been mapped.
router.get("/mappings", (req, res) => {
  res.json({
    categories: EXPENSE_CATEGORIES,
    paymentMethods: PAYMENT_METHODS,
    revenueLineTypes: REVENUE_LINE_TYPES,
    categoryMap: req.tenant.qboExpenseCategoryMap || {},
    paymentAccountMap: req.tenant.qboPaymentAccountMap || {},
    revenueItemMap: req.tenant.qboRevenueItemMap || {},
  });
});

// PUT /quickbooks/mappings — body: { categoryMap, paymentAccountMap, revenueItemMap }
// categoryMap: { [category]: { accountId, accountName } }
// paymentAccountMap: { [paymentMethod]: { accountId, accountName, paymentType } }
// revenueItemMap: { [invoiceLineType]: { itemId, itemName } }
router.put("/mappings", async (req, res) => {
  const { categoryMap, paymentAccountMap, revenueItemMap } = req.body;
  const updated = await prisma.tenant.update({
    where: { id: req.tenantId },
    data: {
      ...(categoryMap !== undefined ? { qboExpenseCategoryMap: categoryMap } : {}),
      ...(paymentAccountMap !== undefined ? { qboPaymentAccountMap: paymentAccountMap } : {}),
      ...(revenueItemMap !== undefined ? { qboRevenueItemMap: revenueItemMap } : {}),
    },
  });
  res.json({
    categoryMap: updated.qboExpenseCategoryMap || {},
    paymentAccountMap: updated.qboPaymentAccountMap || {},
    revenueItemMap: updated.qboRevenueItemMap || {},
  });
});

function randomNonce() {
  return Math.random().toString(36).slice(2);
}

module.exports = router;
