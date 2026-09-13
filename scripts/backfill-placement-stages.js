// One-time data migration for migration 20260912120000_placement_lifecycle_stage.
// The SQL migration renames PlacementInquiry.status -> Placement.stage
// without touching the stored values, so existing rows are still on the old
// lowercase vocabulary (new/touring/pending/placed/declined) after it runs.
// This script maps them onto the new stage list and backfills one
// PlacementEvent per row so the audit trail has a starting point. Idempotent
// — only touches rows still holding a value from the old vocabulary, so it's
// safe to re-run.
//
// Usage: node scripts/backfill-placement-stages.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const OLD_TO_NEW = {
  new: "NEW",
  touring: "FAMILY_REVIEW",
  pending: "DECISION_PENDING",
  declined: "CLOSED",
  // "placed" is handled specially below (depends on placedResidentId).
};

async function main() {
  const legacyValues = [...Object.keys(OLD_TO_NEW), "placed"];
  const rows = await prisma.placement.findMany({
    where: { stage: { in: legacyValues } },
  });

  console.log(`Found ${rows.length} placement(s) on the legacy status vocabulary.`);

  for (const row of rows) {
    let toStage;
    if (row.stage === "placed") {
      // A real Resident already exists -> care has actually started (ACTIVE).
      // External-facility placements never create a Resident -> nothing
      // further to track (COMPLETED).
      toStage = row.placedResidentId ? "ACTIVE" : "COMPLETED";
    } else {
      toStage = OLD_TO_NEW[row.stage];
    }

    const data = { stage: toStage };
    if (row.stage === "declined") {
      // closureReason already holds the old declinedReason value (same
      // column, just renamed by the SQL migration) — keep it as-is if it's
      // already one of the new CLOSURE_REASONS values, otherwise preserve
      // the original text in notes and fall back to "other".
      const CLOSURE_REASONS = ["family_withdrew", "no_suitable_match", "provider_unavailable", "chose_another_provider", "duplicate", "other"];
      if (row.closureReason && !CLOSURE_REASONS.includes(row.closureReason)) {
        data.notes = [row.notes, `Original decline reason: ${row.closureReason}`].filter(Boolean).join("\n");
        data.closureReason = "other";
      }
    }

    await prisma.$transaction([
      prisma.placement.update({ where: { id: row.id }, data }),
      prisma.placementEvent.create({
        data: {
          placementId: row.id,
          fromStage: null,
          toStage,
          changedById: null,
          note: `Migrated from legacy status '${row.stage}'`,
        },
      }),
    ]);

    console.log(`  ${row.id} (${row.residentName}): '${row.stage}' -> '${toStage}'`);
  }

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
