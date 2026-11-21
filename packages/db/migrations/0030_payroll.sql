-- P2-07 Payroll finalization, payment and payslips. RLS is enabled with no policies (deny-all).
-- Wage periods, workers, projects, cost entries, cash accounts and cash transactions are opaque
-- keys: no foreign keys to other modules.

create table pyr_runs (
  id uuid primary key,
  -- BR-1: one run per approved wage period (the period is owned by the wages module).
  period_id uuid not null,
  year integer not null check (year between 2000 and 2200),
  month integer not null check (month between 1 and 12),
  status text not null default 'draft' check (status in ('draft', 'finalized', 'part_paid', 'paid')),
  -- How many times the run was finalized; keeps the cost ledger keys of each cycle apart (BR-7).
  revision integer not null default 0 check (revision >= 0),
  finalized_at timestamptz,
  finalized_by uuid,
  total_net numeric(18,2) not null check (total_net >= 0),
  total_paid numeric(18,2) not null default 0 check (total_paid >= 0),
  -- BR-2: the wage sheet gross, the attendance cost it is compared with and the difference.
  gross_pay numeric(18,2),
  allocated_cost numeric(18,2),
  cost_difference numeric(18,2),
  cost_difference_treatment text not null default 'spread_to_projects'
    check (cost_difference_treatment in ('spread_to_projects', 'overhead')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (period_id)
);
alter table pyr_runs enable row level security;

create table pyr_payments (
  id uuid primary key,
  run_id uuid not null references pyr_runs (id),
  payment_date date not null,
  method text not null check (method in ('cash', 'bank_transfer', 'wallet')),
  account_id uuid not null,
  amount numeric(18,2) not null check (amount > 0),
  status text not null default 'paid' check (status in ('paid', 'reversed')),
  -- BR-4: the approved payment request the cash book accepted, when the amount needed one.
  approval_doc_id uuid,
  paid_by uuid,
  reversed_by uuid,
  reversed_on date,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check ((status = 'reversed') = (reversal_reason is not null))
);
alter table pyr_payments enable row level security;
create index pyr_payments_run_idx on pyr_payments (run_id);

create table pyr_lines (
  id uuid primary key,
  run_id uuid not null references pyr_runs (id),
  worker_id uuid not null,
  net_pay numeric(18,2) not null check (net_pay >= 0),
  payment_method text check (payment_method in ('cash', 'bank_transfer', 'wallet')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  paid_on date,
  payment_id uuid references pyr_payments (id),
  cashbook_txn_id uuid,
  -- BR-3: numbered when the run is finalized, from the series PSL.
  payslip_number text,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (run_id, worker_id),
  check ((payment_status = 'paid') = (payment_id is not null))
);
alter table pyr_lines enable row level security;
create unique index pyr_lines_payslip_uq on pyr_lines (payslip_number) where payslip_number is not null;

-- BR-2: the attendance cost entries moved from approved to posted by one finalization.
create table pyr_cost_entries (
  id uuid primary key,
  run_id uuid not null references pyr_runs (id),
  revision integer not null,
  project_id uuid not null,
  source_doc_type text not null,
  source_doc_id text not null,
  source_line_id text,
  cost_code_id uuid not null,
  amount numeric(18,2) not null,
  entry_date date not null,
  approved_entry_id uuid not null,
  posted_entry_id uuid not null
);
alter table pyr_cost_entries enable row level security;
create index pyr_cost_entries_run_idx on pyr_cost_entries (run_id, revision);

-- BR-2: the posted adjustment of each project (or of overhead) for the difference.
create table pyr_cost_adjustments (
  id uuid primary key,
  run_id uuid not null references pyr_runs (id),
  revision integer not null,
  project_id uuid,
  amount numeric(18,2) not null,
  ledger_entry_id uuid not null
);
alter table pyr_cost_adjustments enable row level security;
create index pyr_cost_adjustments_run_idx on pyr_cost_adjustments (run_id, revision);

insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('payslip', 'PSL', 4, true, false, 1, 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'payroll.run.read'), ('accountant', 'payroll.run.read'), ('management', 'payroll.run.read'),
    ('admin', 'payroll.run.create'), ('accountant', 'payroll.run.create'),
    ('admin', 'payroll.run.finalize'), ('accountant', 'payroll.run.finalize'),
    ('admin', 'payroll.payment.create'), ('accountant', 'payroll.payment.create'),
    ('admin', 'payroll.payment.reverse'), ('management', 'payroll.payment.reverse'),
    ('admin', 'payroll.run.reopen'), ('management', 'payroll.run.reopen'),
    ('admin', 'payroll.payslip.read'), ('accountant', 'payroll.payslip.read'),
    ('management', 'payroll.payslip.read')
  ) as t (role_code, permission_code);
