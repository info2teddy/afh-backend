-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "qbo_purchase_id" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "qbo_expense_category_map" JSONB,
ADD COLUMN     "qbo_payment_account_map" JSONB;
