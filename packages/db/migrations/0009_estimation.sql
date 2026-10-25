-- P1-07 Job templates and internal estimation: reusable templates and cost estimates.
-- RLS is enabled with no policies (deny-all). Items, cost codes, units, parties and leads are opaque
-- keys: no foreign keys to other modules.

create table est_templates (
  id uuid primary key,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
  name text not null check (btrim(name) <> ''),
  work_type text not null check (work_type in
    ('new_build', 'boundary_wall', 'renovation', 'demolition', 'restructure', 'maintenance', 'room', 'slab', 'other')),
  parameters jsonb not null default '[]'::jsonb check (jsonb_typeof(parameters) = 'array'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table est_templates enable row level security;
create unique index est_templates_code_uq on est_templates (lower(code)) where deleted_at is null;

create table est_template_lines (
  id uuid primary key,
  template_id uuid not null references est_templates (id),
  line_no integer not null check (line_no > 0),
  description text not null check (btrim(description) <> ''),
  line_kind text not null check (line_kind in
    ('material', 'labour', 'subcontract', 'equipment', 'disposal', 'salvage_credit')),
  item_id uuid,
  cost_code_id uuid not null,
  unit_code text not null,
  qty_formula text not null check (btrim(qty_formula) <> ''),
  default_rate numeric(18,4) check (default_rate is null or default_rate >= 0),
  supplied_by text not null default 'company' check (supplied_by in ('company', 'client')),
  unique (template_id, line_no)
);
alter table est_template_lines enable row level security;

create table est_estimates (
  id uuid primary key,
  number text not null,
  -- The revision of the estimate (1, 2, ...); `version` below is the concurrency counter (constitution 5.2).
  revision integer not null default 1 check (revision > 0),
  lead_id uuid,
  party_id uuid,
  template_id uuid references est_templates (id),
  title text not null check (btrim(title) <> ''),
  work_type text not null check (work_type in
    ('new_build', 'boundary_wall', 'renovation', 'demolition', 'restructure', 'maintenance', 'room', 'slab', 'other')),
  sector text not null check (sector in ('government', 'private')),
  status text not null default 'draft' check (status in ('draft', 'locked', 'superseded')),
  parent_estimate_id uuid references est_estimates (id),
  parameters_values jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters_values) = 'object'),
  overhead_percent numeric(9,4) not null check (overhead_percent >= 0),
  contingency_percent numeric(9,4) not null check (contingency_percent >= 0),
  target_margin_percent numeric(9,4) not null check (target_margin_percent >= 0 and target_margin_percent < 100),
  proposed_price numeric(18,2) check (proposed_price is null or proposed_price >= 0),
  locked_totals jsonb,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (number, revision),
  check ((status = 'draft') = (locked_totals is null))
);
alter table est_estimates enable row level security;
create index est_estimates_lead_idx on est_estimates (lead_id) where deleted_at is null;
create index est_estimates_status_idx on est_estimates (status) where deleted_at is null;
-- BR-8: a locked estimate has at most one open revision.
create unique index est_estimates_open_revision_uq on est_estimates (parent_estimate_id)
  where status = 'draft' and deleted_at is null and parent_estimate_id is not null;

create table est_estimate_lines (
  id uuid primary key,
  estimate_id uuid not null references est_estimates (id),
  line_no integer not null check (line_no > 0),
  description text not null check (btrim(description) <> ''),
  line_kind text not null check (line_kind in
    ('material', 'labour', 'subcontract', 'equipment', 'disposal', 'salvage_credit')),
  item_id uuid,
  cost_code_id uuid not null,
  unit_code text not null,
  quantity numeric(18,4) not null check (quantity >= 0),
  rate numeric(18,4) not null check (rate >= 0),
  supplied_by text not null default 'company' check (supplied_by in ('company', 'client')),
  note text,
  unique (estimate_id, line_no)
);
alter table est_estimate_lines enable row level security;

insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('estimate', 'EST', 4, false, false, 1, 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'estimation.template.manage'), ('management', 'estimation.template.manage'),
    ('project_manager', 'estimation.template.manage'),
    ('admin', 'estimation.estimate.read'), ('management', 'estimation.estimate.read'),
    ('project_manager', 'estimation.estimate.read'), ('accountant', 'estimation.estimate.read'),
    ('admin', 'estimation.estimate.create'), ('management', 'estimation.estimate.create'),
    ('project_manager', 'estimation.estimate.create'),
    ('admin', 'estimation.estimate.update'), ('management', 'estimation.estimate.update'),
    ('project_manager', 'estimation.estimate.update'),
    ('admin', 'estimation.estimate.lock'), ('management', 'estimation.estimate.lock'),
    ('project_manager', 'estimation.estimate.lock')
  ) as t (role_code, permission_code);
