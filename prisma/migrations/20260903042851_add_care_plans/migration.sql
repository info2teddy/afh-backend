-- CreateTable
CREATE TABLE "care_plans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "resident_id" TEXT NOT NULL,
    "plan_date" TIMESTAMP(3) NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "care_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "care_plans_tenant_id_idx" ON "care_plans"("tenant_id");

-- CreateIndex
CREATE INDEX "care_plans_resident_id_idx" ON "care_plans"("resident_id");

-- AddForeignKey
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
