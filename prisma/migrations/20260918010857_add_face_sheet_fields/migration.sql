-- AlterTable
ALTER TABLE "homes" ADD COLUMN     "fax" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "placements" RENAME CONSTRAINT "placement_inquiries_pkey" TO "placements_pkey";

-- AlterTable
ALTER TABLE "residents" ADD COLUMN     "advanced_directives_type" TEXT,
ADD COLUMN     "allergies" TEXT,
ADD COLUMN     "diagnosis" TEXT,
ADD COLUMN     "dnr_status" TEXT,
ADD COLUMN     "medicaid_number" TEXT,
ADD COLUMN     "medicare_number" TEXT,
ADD COLUMN     "middle_name" TEXT,
ADD COLUMN     "social_security_number" TEXT,
ADD COLUMN     "supplementary_insurance" TEXT;

-- CreateTable
CREATE TABLE "resident_contacts" (
    "id" TEXT NOT NULL,
    "resident_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "fax" TEXT,
    "email" TEXT,
    "address" TEXT,
    "specialty" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resident_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resident_contacts_resident_id_idx" ON "resident_contacts"("resident_id");

-- CreateIndex
CREATE UNIQUE INDEX "resident_contacts_resident_id_role_key" ON "resident_contacts"("resident_id", "role");

-- RenameForeignKey
ALTER TABLE "placements" RENAME CONSTRAINT "placement_inquiries_placed_facility_id_fkey" TO "placements_placed_facility_id_fkey";

-- AddForeignKey
ALTER TABLE "resident_contacts" ADD CONSTRAINT "resident_contacts_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
