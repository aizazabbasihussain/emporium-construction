-- P1-16 Workforce and teams. RLS is enabled with no policies (deny-all). Users and parties are
-- opaque keys: no foreign keys to other modules.

create table lab_trades (
  code text primary key check (code ~ '^[a-z0-9_]+$'),
  name text not null check (btrim(name) <> ''),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table lab_trades enable row level security;

insert into lab_trades (code, name) values
  ('mason', 'Mason'), ('helper', 'Helper'), ('carpenter', 'Carpenter'),
  ('steel_fixer', 'Steel fixer'), ('painter', 'Painter'), ('electrician', 'Electrician'),
  ('plumber', 'Plumber'), ('driver', 'Driver'), ('other', 'Other');

create table lab_workers (
  id uuid primary key,
  code text not null,
  full_name text not null check (btrim(full_name) <> ''),
  father_name text,
  -- BR-1: 13 digits, stored without hyphens. BR-8: masked in lists and logs.
  cnic text check (cnic is null or cnic ~ '^[0-9]{13}$'),
  -- BR-8: E.164, as in master data.
  phone text,
  trade_code text not null references lab_trades (code),
  employment_type text not null check (employment_type in ('permanent', 'daily', 'contract')),
  contractor_party_id uuid,
  joined_on date not null,
  left_on date,
  status text not null default 'active' check (status in ('active', 'inactive')),
  bank_or_wallet_info text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (left_on is null or left_on >= joined_on),
  check (status = 'active' or left_on is not null)
);
alter table lab_workers enable row level security;
create unique index lab_workers_code_uidx on lab_workers (code) where deleted_at is null;
-- BR-1: a CNIC is unique among active workers.
create unique index lab_workers_cnic_active_uidx on lab_workers (cnic)
  where cnic is not null and status = 'active' and deleted_at is null;
create index lab_workers_trade_idx on lab_workers (trade_code) where deleted_at is null;

-- BR-2: effective-dated; the non-overlap rule is enforced in the service under a worker row lock.
create table lab_pay_rates (
  id uuid primary key,
  worker_id uuid not null references lab_workers (id),
  pay_basis text not null check (pay_basis in ('daily_rate', 'monthly_salary')),
  amount numeric(18,2) not null check (amount > 0),
  effective_from date not null,
  effective_to date,
  set_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (effective_to is null or effective_to >= effective_from),
  unique (worker_id, effective_from)
);
alter table lab_pay_rates enable row level security;

create table lab_teams (
  id uuid primary key,
  code text not null,
  name text not null check (btrim(name) <> ''),
  supervisor_user_id uuid not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table lab_teams enable row level security;
create unique index lab_teams_code_uidx on lab_teams (code) where deleted_at is null;
create index lab_teams_supervisor_idx on lab_teams (supervisor_user_id) where deleted_at is null;

-- BR-4: a worker is in at most one team on any date; enforced in the service under a worker lock.
create table lab_team_members (
  team_id uuid not null references lab_teams (id),
  worker_id uuid not null references lab_workers (id),
  from_date date not null,
  to_date date,
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (team_id, worker_id, from_date),
  check (to_date is null or to_date >= from_date)
);
alter table lab_team_members enable row level security;
create index lab_team_members_worker_idx on lab_team_members (worker_id, from_date);

insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('worker', 'WK', 4, false, false, 1, 1), ('team', 'TM', 3, false, false, 1, 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('supervisor', 'workforce.worker.read'), ('project_manager', 'workforce.worker.read'),
    ('management', 'workforce.worker.read'), ('accountant', 'workforce.worker.read'),
    ('management', 'workforce.worker.manage'), ('accountant', 'workforce.worker.manage'),
    ('accountant', 'workforce.rate.read'), ('management', 'workforce.rate.read'),
    ('accountant', 'workforce.rate.manage'), ('management', 'workforce.rate.manage'),
    ('management', 'workforce.team.manage'), ('project_manager', 'workforce.team.manage')
  ) as t (role_code, permission_code);
