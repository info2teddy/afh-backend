-- CreateTable
CREATE TABLE "resident_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "resident_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resident_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resident_notes_tenant_id_idx" ON "resident_notes"("tenant_id");

-- CreateIndex
CREATE INDEX "resident_notes_resident_id_idx" ON "resident_notes"("resident_id");

-- AddForeignKey
ALTER TABLE "resident_notes" ADD CONSTRAINT "resident_notes_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resident_notes" ADD CONSTRAINT "resident_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
