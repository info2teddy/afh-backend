// src/app.js
const express = require("express");
const cors = require("cors");
const { resolveTenant } = require("./middleware/tenant");
const residentsRouter = require("./routes/residents");
const employeesRouter = require("./routes/employees");
const shiftsRouter = require("./routes/shifts");
const invoicesRouter = require("./routes/invoices");
const payrollRouter = require("./routes/payroll");
const quickbooksConnectRouter = require("./routes/quickbooksConnect");
const authRouter = require("./routes/auth");
const onboardingRouter = require("./routes/onboarding");
const tenantsRouter = require("./routes/tenants");
const carePlansRouter = require("./routes/carePlans");

const app = express();

// FRONTEND_ORIGIN must be an exact match (e.g. https://app.yourdomain.com) —
// never use a wildcard "*" once the JWT-based auth is in play, since that
// would let any site read responses containing another origin's session data.
const allowedOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: allowedOrigin, credentials: true }));

app.use(express.json());

// Login and user creation don't require a resolved tenant — they're how a
// tenant context gets established in the first place.
app.use("/auth", authRouter);

// The QuickBooks callback runs BEFORE tenant resolution — at that point the
// tenant is only known from the `state` param Intuit redirects back with, not
// from a header, since the browser hitting this URL has no tenant context yet.
app.use("/quickbooks/callback", quickbooksConnectRouter);

// Admin-only cross-tenant console — an admin browsing/switching between AFH
// businesses has no single tenant context yet, so this does its own auth
// check (see routes/tenants.js) instead of going through resolveTenant.
app.use("/tenants", tenantsRouter);

// Everything below this line requires a resolved tenant.
app.use(resolveTenant);

app.use("/quickbooks", quickbooksConnectRouter); // covers /quickbooks/connect
app.use("/residents", residentsRouter);
app.use("/employees", employeesRouter);
app.use("/shifts", shiftsRouter);
app.use("/invoices", invoicesRouter);
app.use("/payroll", payrollRouter);
app.use("/onboarding", onboardingRouter);
app.use("/care-plans", carePlansRouter);

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AFH backend listening on port ${PORT}`));

module.exports = app;
