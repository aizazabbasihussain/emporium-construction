-- P1-22 Worker self-service login. RLS is enabled with no policies (deny-all). The user and the
-- worker are opaque keys: no foreign keys to other modules' tables. The `worker` role is created
-- at start-up by the module (identity registerRole), which then grants it workerportal.self.read.

create table wkp_worker_accounts (
  user_id uuid primary key,
  -- A worker has at most one login.
  worker_id uuid not null unique,
  linked_by uuid not null,
  linked_at timestamptz not null default now()
);
alter table wkp_worker_accounts enable row level security;

insert into sys_role_permissions (role_code, permission_code) values
  ('admin', 'workerportal.account.manage');
