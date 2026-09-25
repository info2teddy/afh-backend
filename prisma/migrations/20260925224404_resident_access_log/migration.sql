-- CreateTable
CREATE TABLE "resident_access_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "resident_id" TEXT NOT NULL,
    "user_id" TEXT,
    "user_email" TEXT,
    "user_role" TEXT,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resident_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resident_access_logs_tenant_id_resident_id_created_at_idx" ON "resident_access_logs"("tenant_id", "resident_id", "created_at");

-- AddForeignKey
ALTER TABLE "resident_access_logs" ADD CONSTRAINT "resident_access_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
