// src/routes/homes.js
// Minimal read-only listing — homes are created outside the app today (via
// seed/DB), this just lets the frontend populate the "which home" dropdown
// when adding a resident.

const express = require("express");
const { prisma } = require("../middleware/tenant");
const router = express.Router();

router.get("/", async (req, res) => {
  const homes = await prisma.home.findMany({
    where: { tenantId: req.tenantId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  res.json(homes);
});

module.exports = router;
