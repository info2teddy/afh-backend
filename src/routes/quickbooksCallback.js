// src/routes/quickbooksCallback.js
// Intuit redirects the client's browser here after they approve access, as
// a plain top-level navigation with no Authorization header — so this can't
// go through resolveTenant like the rest of the API. app.js mounts this
// router at the exact path "/quickbooks/callback" (before resolveTenant),
// which is why the route below is registered at "/" rather than "/callback".
// The tenant instead comes from `state`, which /quickbooks/connect encoded.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID;
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI;
const QBO_TOKEN_BASE = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

router.get("/", async (req, res) => {
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

module.exports = router;
