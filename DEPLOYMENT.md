# Deploying the AFH system

This covers deploying `afh-backend` (Express + Postgres via Prisma) to Railway,
and `afh-frontend` (Vite + React) to Vercel. Steps marked VERIFIED were tested
directly in this session; steps marked (documented, not independently tested
here) rely on Railway/Vercel's own published behavior, since this session's
sandbox couldn't reach their platforms directly.

## Backend — Railway

1. Push `afh-backend` to a GitHub repo (Railway deploys from a connected repo).
2. In Railway: New Project -> Deploy from GitHub repo -> select it.
3. Add a Postgres plugin to the same project — Railway auto-injects
   `DATABASE_URL` into your service's environment. (documented, not
   independently tested here)
4. Set the remaining environment variables from `.env.production.example`:
   `JWT_SECRET`, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`,
   `FRONTEND_ORIGIN` (must exactly match your deployed frontend's URL — CORS
   was VERIFIED in this session to reject any origin that doesn't match
   exactly).
5. `railway.json` is already set up to run `npx prisma migrate deploy` before
   starting the server, so your schema applies automatically on each deploy.
6. Once live, update your Intuit app's registered Redirect URI to match your
   real `QBO_REDIRECT_URI` — it must match byte-for-byte or the OAuth callback
   will fail (this exact class of mismatch was the reason the standalone QBO
   OAuth scaffold used a working `localhost` URI instead of the placeholder
   `developer.intuit.com/quickstart` value).

## Frontend — Vercel

1. Push `afh-frontend` to a GitHub repo.
2. In Vercel: New Project -> import the repo. Vercel auto-detects Vite.
3. Set `VITE_API_BASE` in Vercel's environment variables to your deployed
   Railway backend's URL.
4. `vercel.json` is already set up with the SPA rewrite rule — VERIFIED in
   this session that without it, a direct request to any client-side route
   (e.g. `/credentials`) 404s on a plain static server, since React Router
   only takes over once JS loads from `index.html`.
5. Deploy. Update the backend's `FRONTEND_ORIGIN` to match the real Vercel URL
   once you have it (Vercel assigns a `*.vercel.app` domain by default, or use
   a custom domain).

## After first deploy — smoke test

- Hit `https://your-backend.up.railway.app/health` — should return `{"status":"ok"}`
- Log in from the deployed frontend using the seeded admin account (see
  `prisma/seed.js` — remember to run the seed once against production, and
  change the seeded password immediately)
- Walk through: generate an invoice, approve a shift, create a payroll run —
  the same flow already verified end-to-end against real Postgres data in
  this session, now against the real deployed stack instead of the sandbox.
