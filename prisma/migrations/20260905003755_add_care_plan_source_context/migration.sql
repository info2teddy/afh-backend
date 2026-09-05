-- AlterTable
ALTER TABLE "care_plans" ADD COLUMN     "source_document_data" BYTEA,
ADD COLUMN     "source_document_mime_type" TEXT,
ADD COLUMN     "source_document_name" TEXT,
ADD COLUMN     "source_notes" TEXT;
