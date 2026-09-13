// src/lib/placementEvents.js
// Single place that writes to PlacementEvent, so every route that changes a
// Placement's stage records the transition the same way instead of each
// route reimplementing it. This table is the whole audit trail/timeline for
// Placement — see the model comment in schema.prisma for why Placement gets
// one and nothing else in this app does.
const { prisma } = require("../middleware/tenant");

async function recordTransition(placementId, { fromStage, toStage, changedById = null, note = null }) {
  return prisma.placementEvent.create({
    data: { placementId, fromStage, toStage, changedById, note },
  });
}

module.exports = { recordTransition };
