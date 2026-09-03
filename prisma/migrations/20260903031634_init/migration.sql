-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quickbooks_realm_id" TEXT,
    "quickbooks_refresh_token" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'manager',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "homes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "license_number" TEXT NOT NULL,
    "address" TEXT,
    "capacity" INTEGER NOT NULL,
    "qbo_location_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "homes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_schedule" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "home_id" TEXT NOT NULL,
    "care_level" TEXT NOT NULL,
    "monthly_rate" DECIMAL(65,30) NOT NULL,
    "room_and_board_rate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "effective_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "residents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "home_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "care_level" TEXT NOT NULL,
    "payer_type" TEXT NOT NULL,
    "medicaid_split_pct" DECIMAL(65,30),
    "move_in_date" TIMESTAMP(3) NOT NULL,
    "move_out_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "qbo_customer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "residents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "home_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "hire_date" TIMESTAMP(3) NOT NULL,
    "pay_rate" DECIMAL(65,30) NOT NULL,
    "employment_type" TEXT NOT NULL,
    "live_in" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "qbo_employee_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_requirement_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deadline_type" TEXT NOT NULL,
    "deadline_days" INTEGER,
    "gate_name" TEXT,
    "is_conditional" BOOLEAN NOT NULL DEFAULT false,
    "depends_on_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "onboarding_requirement_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_onboarding_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "due_date" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_onboarding_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_home_assignments" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "home_id" TEXT NOT NULL,

    CONSTRAINT "employee_home_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "credential_type" TEXT NOT NULL,
    "issue_date" TIMESTAMP(3) NOT NULL,
    "expiration_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "home_id" TEXT NOT NULL,
    "clock_in" TIMESTAMP(3) NOT NULL,
    "clock_out" TIMESTAMP(3),
    "shift_type" TEXT NOT NULL,
    "sleep_time_excluded_minutes" INTEGER NOT NULL DEFAULT 0,
    "sleep_interrupted" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "resident_id" TEXT NOT NULL,
    "billing_period_start" TIMESTAMP(3) NOT NULL,
    "billing_period_end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "total_amount" DECIMAL(65,30) NOT NULL,
    "qbo_invoice_id" TEXT,
    "qbo_sync_token" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "line_type" TEXT NOT NULL,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "pay_period_start" TIMESTAMP(3) NOT NULL,
    "pay_period_end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'calculated',
    "total_gross_pay" DECIMAL(65,30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_line_items" (
    "id" TEXT NOT NULL,
    "payroll_run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "regular_hours" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "overtime_hours" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "gross_pay" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "payroll_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE INDEX "homes_tenant_id_idx" ON "homes"("tenant_id");

-- CreateIndex
CREATE INDEX "rate_schedule_tenant_id_idx" ON "rate_schedule"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_schedule_home_id_care_level_effective_date_key" ON "rate_schedule"("home_id", "care_level", "effective_date");

-- CreateIndex
CREATE INDEX "residents_tenant_id_idx" ON "residents"("tenant_id");

-- CreateIndex
CREATE INDEX "residents_home_id_idx" ON "residents"("home_id");

-- CreateIndex
CREATE INDEX "employees_tenant_id_idx" ON "employees"("tenant_id");

-- CreateIndex
CREATE INDEX "employees_home_id_idx" ON "employees"("home_id");

-- CreateIndex
CREATE INDEX "onboarding_requirement_templates_tenant_id_idx" ON "onboarding_requirement_templates"("tenant_id");

-- CreateIndex
CREATE INDEX "employee_onboarding_items_tenant_id_idx" ON "employee_onboarding_items"("tenant_id");

-- CreateIndex
CREATE INDEX "employee_onboarding_items_employee_id_idx" ON "employee_onboarding_items"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_onboarding_items_employee_id_template_id_key" ON "employee_onboarding_items"("employee_id", "template_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_home_assignments_employee_id_home_id_key" ON "employee_home_assignments"("employee_id", "home_id");

-- CreateIndex
CREATE INDEX "credentials_tenant_id_idx" ON "credentials"("tenant_id");

-- CreateIndex
CREATE INDEX "credentials_employee_id_idx" ON "credentials"("employee_id");

-- CreateIndex
CREATE INDEX "credentials_expiration_date_idx" ON "credentials"("expiration_date");

-- CreateIndex
CREATE INDEX "shifts_tenant_id_idx" ON "shifts"("tenant_id");

-- CreateIndex
CREATE INDEX "shifts_employee_id_clock_in_idx" ON "shifts"("employee_id", "clock_in");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_idx" ON "invoices"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_resident_id_billing_period_start_key" ON "invoices"("resident_id", "billing_period_start");

-- CreateIndex
CREATE INDEX "invoice_line_items_invoice_id_idx" ON "invoice_line_items"("invoice_id");

-- CreateIndex
CREATE INDEX "payroll_runs_tenant_id_idx" ON "payroll_runs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tenant_id_pay_period_start_key" ON "payroll_runs"("tenant_id", "pay_period_start");

-- CreateIndex
CREATE INDEX "payroll_line_items_payroll_run_id_idx" ON "payroll_line_items"("payroll_run_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homes" ADD CONSTRAINT "homes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residents" ADD CONSTRAINT "residents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "residents" ADD CONSTRAINT "residents_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "homes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "homes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_requirement_templates" ADD CONSTRAINT "onboarding_requirement_templates_depends_on_id_fkey" FOREIGN KEY ("depends_on_id") REFERENCES "onboarding_requirement_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_onboarding_items" ADD CONSTRAINT "employee_onboarding_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_onboarding_items" ADD CONSTRAINT "employee_onboarding_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "onboarding_requirement_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_home_assignments" ADD CONSTRAINT "employee_home_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_home_assignments" ADD CONSTRAINT "employee_home_assignments_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "homes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "homes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
