-- AlterTable
ALTER TABLE "adl_entries" ADD COLUMN     "shift" TEXT;

-- CreateTable
CREATE TABLE "vitals_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "resident_id" TEXT NOT NULL,
    "shift" TEXT,
    "temperature" DECIMAL(4,1),
    "temperature_route" TEXT,
    "pulse" INTEGER,
    "respirations" INTEGER,
    "blood_pressure" TEXT,
    "weight" DECIMAL(6,1),
    "intake" TEXT,
    "output" TEXT,
    "rom" TEXT,
    "notes" TEXT,
    "logged_by_id" TEXT NOT NULL,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vitals_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vitals_entries_tenant_id_idx" ON "vitals_entries"("tenant_id");

-- CreateIndex
CREATE INDEX "vitals_entries_resident_id_idx" ON "vitals_entries"("resident_id");

-- AddForeignKey
ALTER TABLE "vitals_entries" ADD CONSTRAINT "vitals_entries_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals_entries" ADD CONSTRAINT "vitals_entries_logged_by_id_fkey" FOREIGN KEY ("logged_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
