-- Phase 2 of the Placement lifecycle build: matching, shortlist, family
-- review sharing, introductions, and decisions. All additive — no renames,
-- so this is safe to generate/apply normally (no hand-editing needed like
-- the Phase 1 table-rename migration).

-- AlterTable
ALTER TABLE "placements" ADD COLUMN "share_token" TEXT,
ADD COLUMN "share_token_expires_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "placements_share_token_key" ON "placements"("share_token");

-- CreateTable
CREATE TABLE "placement_shortlist_entries" (
    "id" TEXT NOT NULL,
    "placement_id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "placement_shortlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "placement_shortlist_entries_placement_id_idx" ON "placement_shortlist_entries"("placement_id");

-- CreateIndex
CREATE UNIQUE INDEX "placement_shortlist_entries_placement_id_facility_id_key" ON "placement_shortlist_entries"("placement_id", "facility_id");

-- AddForeignKey
ALTER TABLE "placement_shortlist_entries" ADD CONSTRAINT "placement_shortlist_entries_placement_id_fkey" FOREIGN KEY ("placement_id") REFERENCES "placements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_shortlist_entries" ADD CONSTRAINT "placement_shortlist_entries_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "placement_facilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "placement_introductions" (
    "id" TEXT NOT NULL,
    "placement_id" TEXT NOT NULL,
    "facility_id" TEXT NOT NULL,
    "staff_id" TEXT,
    "scheduled_at" TIMESTAMP(3),
    "method" TEXT,
    "notes" TEXT,
    "outcome" TEXT,
    "family_decision" TEXT,
    "provider_decision" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "placement_introductions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "placement_introductions_placement_id_idx" ON "placement_introductions"("placement_id");

-- AddForeignKey
ALTER TABLE "placement_introductions" ADD CONSTRAINT "placement_introductions_placement_id_fkey" FOREIGN KEY ("placement_id") REFERENCES "placements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_introductions" ADD CONSTRAINT "placement_introductions_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "placement_facilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_introductions" ADD CONSTRAINT "placement_introductions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
