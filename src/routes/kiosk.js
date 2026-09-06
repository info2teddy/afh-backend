// src/routes/kiosk.js
// The one non-shift endpoint a kiosk-role login is allowed to call (see
// middleware/kioskRestrict.js) — just enough to render the clock-in picker.
// Deliberately excludes pay rate, PIN hash, hire date, credentials, and
// everything else GET /employees returns, so a shared-tablet session can't
// see anything beyond names, even by calling the API directly.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

router.get("/employees", async (req, res) => {
  const employees = await prisma.employee.findMany({
    where: { tenantId: req.tenantId, status: "active" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  res.json(employees);
});

module.exports = router;
