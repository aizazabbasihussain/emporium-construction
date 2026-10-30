-- P1-18 Monthly wage calculation. RLS is enabled with no policies (deny-all). Workers and teams are
-- opaque keys: no foreign keys to other modules.

create table wag_periods (
  id uuid primary key,
  year integer not null check (year between 2000 and 2100),
  month integer not null check (month between 1 and 12),
  status text not null default 'draft'
    check (status in ('draft', 'calculated', 'submitted', 'approved', 'reopened')),
  calculated_at timestamptz,
  -- BR-11: the net pay of the period, frozen when it is submitted (the amount of the approval).
  total_net numeric(18,2) not null default 0,
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  -- BR-9: who acknowledged the warnings when the period was submitted.
  warnings_acknowledged_by uuid,
  reopen_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (year, month)
);
alter table wag_periods enable row level security;

create table wag_lines (
  id uuid primary key,
  period_id uuid not null references wag_periods (id),
  worker_id uuid not null,
  -- The worker's code and name as they were when calculated, so a wage sheet reads on its own.
  worker_code text not null,
  worker_name text not null,
  pay_basis text not null check (pay_basis in ('daily_rate', 'monthly_salary')),
  rate numeric(18,2) not null,
  present_days numeric(6,2) not null default 0,
  half_days numeric(6,2) not null default 0,
  paid_leave_days numeric(6,2) not null default 0,
  off_days numeric(6,2) not null default 0,
  absent_days numeric(6,2) not null default 0,
  overtime_hours numeric(7,2) not null default 0,
  basic_pay numeric(18,2) not null default 0,
  overtime_pay numeric(18,2) not null default 0,
  allowances numeric(18,2) not null default 0,
  deductions numeric(18,2) not null default 0,
  advance_recovery numeric(18,2) not null default 0,
  gross_pay numeric(18,2) not null default 0,
  net_pay numeric(18,2) not null default 0 check (net_pay >= 0),
  rounding_adjustment numeric(18,2) not null default 0,
  -- BR-5: deductions beyond the gross pay, left for a manual decision.
  shortfall numeric(18,2) not null default 0,
  note text,
  unique (period_id, worker_id)
);
alter table wag_lines enable row level security;
create index wag_lines_worker_idx on wag_lines (worker_id);

create table wag_adjustments (
  id uuid primary key,
  line_id uuid not null references wag_lines (id),
  kind text not null check (kind in ('allowance', 'deduction')),
  amount numeric(18,2) not null check (amount > 0),
  reason text not null check (reason <> ''),
  added_by uuid,
  added_at timestamptz not null default now()
);
alter table wag_adjustments enable row level security;
create index wag_adjustments_line_idx on wag_adjustments (line_id);

create table wag_advances (
  id uuid primary key,
  worker_id uuid not null,
  amount numeric(18,2) not null check (amount > 0),
  issued_on date not null,
  monthly_recovery numeric(18,2) not null check (monthly_recovery > 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table wag_advances enable row level security;
create index wag_advances_worker_idx on wag_advances (worker_id);

-- BR-6: the recovery planned by a calculation; `applied` turns true only when the period is approved
-- and goes back to false when it is reopened, so the balance of an advance moves only on approval.
create table wag_advance_recoveries (
  advance_id uuid not null references wag_advances (id),
  period_id uuid not null references wag_periods (id),
  line_id uuid not null references wag_lines (id),
  amount numeric(18,2) not null check (amount > 0),
  applied boolean not null default false,
  primary key (advance_id, period_id)
);
alter table wag_advance_recoveries enable row level security;
create index wag_advance_recoveries_period_idx on wag_advance_recoveries (period_id);

-- BR-11 / H-09: the owner (management role) approves a wage period. The matrix stays editable.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:wage_period')::uuid, 'wage_period', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:wage_period')::uuid, 1, 'management', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('accountant', 'wages.period.read'), ('management', 'wages.period.read'),
    ('accountant', 'wages.period.calculate'), ('management', 'wages.period.calculate'),
    ('accountant', 'wages.period.submit'), ('management', 'wages.period.submit'),
    ('management', 'wages.period.reopen'),
    ('accountant', 'wages.adjustment.manage'),
    ('accountant', 'wages.advance.manage')
  ) as t (role_code, permission_code);
