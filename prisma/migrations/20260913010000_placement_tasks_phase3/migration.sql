-- Phase 3 of the Placement lifecycle build: tasks, move-in checklist, and
-- follow-up scheduling. Purely additive.

-- CreateTable
CREATE TABLE "placement_tasks" (
    "id" TEXT NOT NULL,
    "placement_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "due_date" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "assigned_to_id" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "placement_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "placement_tasks_placement_id_idx" ON "placement_tasks"("placement_id");

-- AddForeignKey
ALTER TABLE "placement_tasks" ADD CONSTRAINT "placement_tasks_placement_id_fkey" FOREIGN KEY ("placement_id") REFERENCES "placements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_tasks" ADD CONSTRAINT "placement_tasks_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
