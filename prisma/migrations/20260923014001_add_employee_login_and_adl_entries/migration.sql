-- AlterTable
ALTER TABLE "users" ADD COLUMN     "employee_id" TEXT;

-- CreateTable
CREATE TABLE "adl_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "resident_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "note" TEXT,
    "logged_by_id" TEXT NOT NULL,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adl_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- CreateIndex
CREATE INDEX "adl_entries_tenant_id_idx" ON "adl_entries"("tenant_id");

-- CreateIndex
CREATE INDEX "adl_entries_resident_id_idx" ON "adl_entries"("resident_id");

-- CreateIndex
CREATE INDEX "adl_entries_resident_id_domain_idx" ON "adl_entries"("resident_id", "domain");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adl_entries" ADD CONSTRAINT "adl_entries_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adl_entries" ADD CONSTRAINT "adl_entries_logged_by_id_fkey" FOREIGN KEY ("logged_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
