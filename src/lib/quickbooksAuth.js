// src/lib/quickbooksAuth.js
// Same OAuth flow shape as the standalone gusto_oauth.js example, but tokens are
// now stored per tenant in Postgres (tenants.quickbooks_refresh_token), not in
// an in-memory object — this is what makes multi-client support actually work.

const { prisma } = require("../middleware/tenant");

// Two DIFFERENT Intuit hosts, easy to conflate:
//   - oauth.platform.intuit.com   -> token issuance/refresh (this file)
//   - sandbox-quickbooks.api.intuit.com -> the actual Accounting API calls (quickbooksClient.js)
// An earlier version of this file mistakenly posted refresh requests to the
// Accounting API host, which would fail every refresh. Confirmed against
// Intuit's own documented OAuth 2.0 endpoint before fixing.
const QBO_TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID;
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;

// In-memory cache of short-lived access tokens, keyed by tenant — avoids hitting
// the refresh endpoint on every single API call. Access tokens last ~1 hour.
const accessTokenCache = {};

async function getValidAccessToken(tenantId) {
  const cached = accessTokenCache[tenantId];
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }
  return refreshAccessToken(tenantId);
}

async function refreshAccessToken(tenantId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.quickbooksRefreshToken) {
    throw new Error(`Tenant ${tenantId} has no QuickBooks connection — reconnect required.`);
  }

  const res = await fetch(QBO_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tenant.quickbooksRefreshToken,
    }),
  });
  if (!res.ok) throw new Error(`QuickBooks token refresh failed: ${await res.text()}`);

  const tokens = await res.json();

  // QuickBooks rotates refresh tokens too — persist the new one immediately
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { quickbooksRefreshToken: tokens.refresh_token },
  });

  accessTokenCache[tenantId] = {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  return tokens.access_token;
}

module.exports = { getValidAccessToken };
