-- AlterTable
ALTER TABLE "residents" ADD COLUMN     "authorization_status" TEXT,
ADD COLUMN     "date_of_birth" TIMESTAMP(3),
ADD COLUMN     "next_assessment_date" TIMESTAMP(3),
ADD COLUMN     "room" TEXT;
