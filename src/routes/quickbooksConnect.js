// src/routes/quickbooksConnect.js
// The one-time "Connect QuickBooks" flow for a tenant. Distinct from
// quickbooksAuth.js, which only handles refreshing an ALREADY-connected tenant's
// access token, and from quickbooksCallback.js, which handles Intuit's redirect
// back (that one runs BEFORE tenant resolution — see app.js for why).

const express = require("express");
const router = express.Router();

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID;
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI; // e.g. https://yourapp.com/quickbooks/callback
const QBO_AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";

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

function randomNonce() {
  return Math.random().toString(36).slice(2);
}

module.exports = router;
