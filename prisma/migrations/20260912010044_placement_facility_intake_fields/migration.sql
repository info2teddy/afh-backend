-- AlterTable
ALTER TABLE "placement_facilities" ADD COLUMN     "accepts_medicaid" BOOLEAN,
ADD COLUMN     "current_residents" INTEGER,
ADD COLUMN     "gender_accepted" TEXT,
ADD COLUMN     "license_expiry_date" TIMESTAMP(3),
ADD COLUMN     "license_number" TEXT,
ADD COLUMN     "medicaid_managed_care_orgs" TEXT,
ADD COLUMN     "ok_to_share_with_families" BOOLEAN,
ADD COLUMN     "private_room_pricing" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "shared_room_pricing" TEXT,
ADD COLUMN     "specialty_care" TEXT,
ADD COLUMN     "submitted_by_facility" BOOLEAN NOT NULL DEFAULT false;
