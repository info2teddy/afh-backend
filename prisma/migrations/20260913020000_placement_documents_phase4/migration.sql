-- Phase 4 of the Placement lifecycle build: documents and a manual
-- communications log. Purely additive.

-- CreateTable
CREATE TABLE "placement_documents" (
    "id" TEXT NOT NULL,
    "placement_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "placement_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "placement_documents_placement_id_idx" ON "placement_documents"("placement_id");

-- AddForeignKey
ALTER TABLE "placement_documents" ADD CONSTRAINT "placement_documents_placement_id_fkey" FOREIGN KEY ("placement_id") REFERENCES "placements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_documents" ADD CONSTRAINT "placement_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "placement_communications" (
    "id" TEXT NOT NULL,
    "placement_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "logged_by_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "placement_communications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "placement_communications_placement_id_idx" ON "placement_communications"("placement_id");

-- AddForeignKey
ALTER TABLE "placement_communications" ADD CONSTRAINT "placement_communications_placement_id_fkey" FOREIGN KEY ("placement_id") REFERENCES "placements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placement_communications" ADD CONSTRAINT "placement_communications_logged_by_id_fkey" FOREIGN KEY ("logged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
