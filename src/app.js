// src/app.js
const express = require("express");
// Must load before any router is required: it patches Express's route/router
// methods so a rejected promise from an async handler reaches the error
// middleware below via next(err), instead of becoming an unhandled promise
// rejection — which, on Node 15+, terminates the whole process (verified:
// a duplicate payroll run for an already-run period threw an uncaught
// Prisma unique-constraint error and took the entire server down for every
// tenant, not just that one request).
require("express-async-errors");
const cors = require("cors");
const { resolveTenant } = require("./middleware/tenant");
const { restrictKiosk } = require("./middleware/kioskRestrict");
const kioskRouter = require("./routes/kiosk");
const residentsRouter = require("./routes/residents");
const employeesRouter = require("./routes/employees");
const shiftsRouter = require("./routes/shifts");
const invoicesRouter = require("./routes/invoices");
const payrollRouter = require("./routes/payroll");
const quickbooksConnectRouter = require("./routes/quickbooksConnect");
const quickbooksCallbackRouter = require("./routes/quickbooksCallback");
const authRouter = require("./routes/auth");
const onboardingRouter = require("./routes/onboarding");
const tenantsRouter = require("./routes/tenants");
const carePlansRouter = require("./routes/carePlans");
const homesRouter = require("./routes/homes");
const expensesRouter = require("./routes/expenses");
const financeRouter = require("./routes/finance");
const analyticsRouter = require("./routes/analytics");
const alertsRouter = require("./routes/alerts");

const app = express();

// FRONTEND_ORIGIN must be an exact match (e.g. https://app.yourdomain.com) —
// never use a wildcard "*" once the JWT-based auth is in play, since that
// would let any site read responses containing another origin's session data.
const allowedOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: allowedOrigin, credentials: true }));

app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Login and user creation don't require a resolved tenant — they're how a
// tenant context gets established in the first place.
app.use("/auth", authRouter);

// The QuickBooks callback runs BEFORE tenant resolution — at that point the
// tenant is only known from the `state` param Intuit redirects back with, not
// from a header, since the browser hitting this URL has no tenant context yet.
app.use("/quickbooks/callback", quickbooksCallbackRouter);

// Admin-only cross-tenant console — an admin browsing/switching between AFH
// businesses has no single tenant context yet, so this does its own auth
// check (see routes/tenants.js) instead of going through resolveTenant.
app.use("/tenants", tenantsRouter);

// Everything below this line requires a resolved tenant.
app.use(resolveTenant);

// Blocks a kiosk-role token from everything except clock in/out — see
// middleware/kioskRestrict.js. Placed once, here, so every router below
// benefits without each needing its own kiosk check.
app.use(restrictKiosk);

app.use("/kiosk", kioskRouter);
app.use("/quickbooks", quickbooksConnectRouter); // covers /quickbooks/connect
app.use("/residents", residentsRouter);
app.use("/homes", homesRouter);
app.use("/employees", employeesRouter);
app.use("/shifts", shiftsRouter);
app.use("/invoices", invoicesRouter);
app.use("/payroll", payrollRouter);
app.use("/onboarding", onboardingRouter);
app.use("/care-plans", carePlansRouter);
app.use("/expenses", expensesRouter);
app.use("/finance", financeRouter);
app.use("/analytics", analyticsRouter);
app.use("/alerts", alertsRouter);

// Final safety net — catches anything a route didn't handle itself (now
// reachable thanks to express-async-errors above) so a bug in one request
// returns a clean 500 to that caller instead of crashing every tenant's
// connection to the process.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: "Something went wrong on our end. Please try again." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AFH backend listening on port ${PORT}`));

module.exports = app;
