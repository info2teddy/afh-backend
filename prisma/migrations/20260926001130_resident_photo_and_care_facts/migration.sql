-- AlterTable
ALTER TABLE "residents" ADD COLUMN     "cognition" TEXT,
ADD COLUMN     "diet" TEXT,
ADD COLUMN     "fall_risk" TEXT,
ADD COLUMN     "mobility" TEXT,
ADD COLUMN     "photo_data" BYTEA,
ADD COLUMN     "photo_mime_type" TEXT,
ADD COLUMN     "photo_updated_at" TIMESTAMP(3);
