// src/routes/quickbooksConnect.js
// The one-time "Connect QuickBooks" flow for a tenant. Distinct from
// quickbooksAuth.js, which only handles refreshing an ALREADY-connected tenant's
// access token. This is what runs during onboarding, once per client.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID;
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI; // e.g. https://yourapp.com/quickbooks/callback
const QBO_AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const QBO_TOKEN_BASE = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// GET /quickbooks/connect — the "Connect QuickBooks" button in the client's
// settings screen hits this. req.tenantId is already resolved by the tenant
// middleware, and gets encoded into `state` so the callback knows which
// tenant to attach the tokens to.
router.get("/connect", (req, res) => {
  const state = Buffer.from(JSON.stringify({ tenantId: req.tenantId, nonce: randomNonce() })).toString("base64url");

  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    redirect_uri: QBO_REDIRECT_URI,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    state,
  });
  res.redirect(`${QBO_AUTH_BASE}?${params.toString()}`);
});

// GET /quickbooks/callback — Intuit redirects here after the client approves access.
// Note: this route runs BEFORE the tenant middleware in app.js, since the tenant
// isn't known from a header at this point — it's decoded from `state` instead.
router.get("/callback", async (req, res) => {
  const { code, state, realmId } = req.query;
  if (!code || !state || !realmId) {
    return res.status(400).send("Missing code, state, or realmId from QuickBooks redirect.");
  }

  let tenantId;
  try {
    ({ tenantId } = JSON.parse(Buffer.from(state, "base64url").toString()));
  } catch {
    return res.status(400).send("Invalid state parameter.");
  }

  try {
    const tokenRes = await fetch(QBO_TOKEN_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: QBO_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(await tokenRes.text());
    const tokens = await tokenRes.json();

    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        quickbooksRealmId: realmId,
        quickbooksRefreshToken: tokens.refresh_token,
      },
    });

    res.send("QuickBooks connected successfully. You can close this window.");
  } catch (err) {
    console.error("QuickBooks OAuth callback failed:", err);
    res.status(500).send("Something went wrong connecting QuickBooks. Try again.");
  }
});

function randomNonce() {
  return Math.random().toString(36).slice(2);
}

module.exports = router;
