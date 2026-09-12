-- CreateTable
CREATE TABLE "placement_facilities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "capacity" INTEGER,
    "care_levels_accepted" TEXT,
    "notes" TEXT,
    "tenant_id" TEXT,
    "home_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "placement_facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "placement_inquiries" (
    "id" TEXT NOT NULL,
    "resident_name" TEXT NOT NULL,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "referral_source" TEXT,
    "care_level_needed" TEXT NOT NULL,
    "payer_type" TEXT NOT NULL,
    "urgency" TEXT NOT NULL DEFAULT 'normal',
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "declined_reason" TEXT,
    "placed_facility_id" TEXT,
    "placed_resident_id" TEXT,
    "placed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "placement_inquiries_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "placement_inquiries" ADD CONSTRAINT "placement_inquiries_placed_facility_id_fkey" FOREIGN KEY ("placed_facility_id") REFERENCES "placement_facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
