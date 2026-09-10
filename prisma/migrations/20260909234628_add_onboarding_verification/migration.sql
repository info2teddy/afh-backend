-- AlterTable
ALTER TABLE "employee_onboarding_items" ADD COLUMN     "document_data" BYTEA,
ADD COLUMN     "document_mime_type" TEXT,
ADD COLUMN     "document_name" TEXT,
ADD COLUMN     "verified_expiration_date" TIMESTAMP(3),
ADD COLUMN     "verified_name" TEXT;

-- AlterTable
ALTER TABLE "onboarding_requirement_templates" ADD COLUMN     "credential_type" TEXT,
ADD COLUMN     "requires_document" BOOLEAN NOT NULL DEFAULT false;
