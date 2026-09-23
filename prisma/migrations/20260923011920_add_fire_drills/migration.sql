-- CreateTable
CREATE TABLE "fire_drills" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "home_id" TEXT NOT NULL,
    "drilled_at" TIMESTAMP(3) NOT NULL,
    "shift" TEXT,
    "conducted_by_name" TEXT NOT NULL,
    "staff_present" TEXT,
    "residents_participated" INTEGER,
    "residents_exempted" INTEGER,
    "exemption_reason" TEXT,
    "evacuation_seconds" INTEGER,
    "issues_noted" TEXT,
    "corrective_action" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fire_drills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fire_drills_tenant_id_idx" ON "fire_drills"("tenant_id");

-- CreateIndex
CREATE INDEX "fire_drills_home_id_idx" ON "fire_drills"("home_id");

-- CreateIndex
CREATE INDEX "fire_drills_drilled_at_idx" ON "fire_drills"("drilled_at");

-- AddForeignKey
ALTER TABLE "fire_drills" ADD CONSTRAINT "fire_drills_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "homes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
