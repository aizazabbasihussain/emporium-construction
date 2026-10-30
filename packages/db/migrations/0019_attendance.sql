-- P1-17 Attendance and labour costing. RLS is enabled with no policies (deny-all). Teams, workers,
-- projects and cost codes are opaque keys: no foreign keys to other modules.

create table att_sheets (
  id uuid primary key,
  team_id uuid not null,
  sheet_date date not null,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'unlocked')),
  -- BR-6: the labour cost of the sheet, frozen when it is submitted (the amount of the approval).
  total numeric(18,2) not null default 0 check (total >= 0),
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  -- BR-7: why an approved sheet was unlocked.
  unlock_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (team_id, sheet_date)
);
alter table att_sheets enable row level security;
create index att_sheets_date_idx on att_sheets (sheet_date) where deleted_at is null;
create index att_sheets_status_idx on att_sheets (status) where deleted_at is null;

create table att_entries (
  id uuid primary key,
  sheet_id uuid not null references att_sheets (id),
  line_no integer not null check (line_no > 0),
  worker_id uuid not null,
  -- The worker's code and name as they were on the sheet, so a sheet reads without the workforce module.
  worker_code text not null,
  worker_name text not null,
  status text not null
    check (status in ('present', 'half_day', 'absent', 'leave_paid', 'leave_unpaid', 'off')),
  overtime_hours numeric(5,2) not null default 0 check (overtime_hours >= 0 and overtime_hours <= 8),
  -- BR-5: overtime goes to the first allocation's project unless this names another one.
  overtime_project_id uuid,
  remarks text,
  -- BR-4: the pay frozen when the sheet is submitted.
  daily_rate numeric(18,4),
  day_value numeric(18,2),
  overtime_value numeric(18,2),
  -- BR-6: the latest ledger entry of the separate overtime line, if there is one.
  overtime_cost_entry_id uuid,
  unique (sheet_id, worker_id),
  unique (sheet_id, line_no)
);
alter table att_entries enable row level security;
create index att_entries_worker_idx on att_entries (worker_id);

create table att_allocations (
  id uuid primary key,
  entry_id uuid not null references att_entries (id),
  -- The order the supervisor gave; the first allocation carries the overtime (BR-5).
  position integer not null check (position > 0),
  cost_object_type text not null default 'project' check (cost_object_type = 'project'),
  cost_object_id uuid not null,
  fraction numeric(5,4) not null check (fraction > 0 and fraction <= 1),
  cost_code_id uuid not null,
  -- BR-6: the money of this worker-day-project, frozen when the sheet is submitted.
  amount numeric(18,2),
  -- BR-6: the latest entry of the line's chain in the cost ledger; null before approval.
  cost_entry_id uuid
);
alter table att_allocations enable row level security;
create index att_allocations_entry_idx on att_allocations (entry_id);
create index att_allocations_project_idx on att_allocations (cost_object_id);

-- BR-2: a worker is on one sheet at most per date, across all sheets.
create table att_worker_days (
  worker_id uuid not null,
  work_date date not null,
  sheet_id uuid not null references att_sheets (id),
  primary key (worker_id, work_date)
);
alter table att_worker_days enable row level security;
create index att_worker_days_sheet_idx on att_worker_days (sheet_id);

-- BR-6 / H-09: the project manager approves a sheet. The matrix stays editable from the screen.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:attendance_sheet')::uuid, 'attendance_sheet', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:attendance_sheet')::uuid, 1, 'project_manager', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('supervisor', 'attendance.sheet.create'), ('project_manager', 'attendance.sheet.create'),
    ('supervisor', 'attendance.sheet.update'), ('project_manager', 'attendance.sheet.update'),
    ('supervisor', 'attendance.sheet.read'), ('project_manager', 'attendance.sheet.read'),
    ('management', 'attendance.sheet.read'), ('accountant', 'attendance.sheet.read'),
    ('management', 'attendance.sheet.unlock'), ('project_manager', 'attendance.sheet.unlock')
  ) as t (role_code, permission_code);
