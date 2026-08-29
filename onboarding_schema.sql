-- onboarding_schema.sql
-- Appends to schema.sql: onboarding requirement library + per-employee tracking

create table onboarding_requirement_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  deadline_type text not null check (deadline_type in ('fixed_days', 'gate', 'conditional')),
  deadline_days int, -- set only when deadline_type = 'fixed_days'
  gate_name text,    -- set only when deadline_type = 'gate', e.g. 'before_unsupervised_care'
  is_conditional boolean not null default false,
  depends_on_id uuid references onboarding_requirement_templates(id),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_onboarding_templates_tenant on onboarding_requirement_templates(tenant_id);

create table employee_onboarding_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  template_id uuid not null references onboarding_requirement_templates(id),
  due_date date,        -- computed at creation for fixed_days items; null for gate/conditional
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (employee_id, template_id)
);
create index idx_onboarding_items_tenant on employee_onboarding_items(tenant_id);
create index idx_onboarding_items_employee on employee_onboarding_items(employee_id);
create index idx_onboarding_items_due_date on employee_onboarding_items(due_date);
