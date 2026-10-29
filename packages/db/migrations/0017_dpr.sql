-- P1-15 Daily progress reports. RLS is enabled with no policies (deny-all). Users, projects, tasks
-- and files are opaque keys: no foreign keys to other modules.

create table dpr_reports (
  id uuid primary key,
  project_id uuid not null,
  report_date date not null,
  author_id uuid not null,
  weather text not null default 'clear'
    check (weather in ('clear', 'cloudy', 'rain', 'extreme_heat', 'other')),
  work_done text not null default '',
  issues text not null default '',
  safety_notes text not null default '',
  -- BR-8: trades not tracked by attendance, entered by hand: [{ "trade": text, "count": integer }].
  manpower_manual jsonb not null default '[]'::jsonb check (jsonb_typeof(manpower_manual) = 'array'),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'reviewed', 'reopened')),
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table dpr_reports enable row level security;
-- BR-2: one report per author per project per date.
create unique index dpr_reports_author_day_uidx
  on dpr_reports (project_id, report_date, author_id) where deleted_at is null;
create index dpr_reports_project_date_idx on dpr_reports (project_id, report_date desc)
  where deleted_at is null;

create table dpr_task_updates (
  report_id uuid not null references dpr_reports (id),
  task_id uuid not null,
  percent_complete integer not null check (percent_complete between 0 and 100),
  note text,
  primary key (report_id, task_id)
);
alter table dpr_task_updates enable row level security;

create table dpr_material_notes (
  id uuid primary key,
  report_id uuid not null references dpr_reports (id),
  line_no integer not null check (line_no > 0),
  description text not null check (btrim(description) <> ''),
  quantity numeric(18,4) check (quantity is null or quantity >= 0),
  unit_code text,
  unique (report_id, line_no)
);
alter table dpr_material_notes enable row level security;

-- BR-6: the 18:00 job records the business day it has run for, so a minute tick runs it once.
create table dpr_missing_runs (
  report_date date primary key,
  ran_at timestamptz not null default now(),
  missing_count integer not null check (missing_count >= 0)
);
alter table dpr_missing_runs enable row level security;

-- Published read view (spec section 2): which projects have filed a report for which day.
create view dpr_v_submission_status with (security_invoker = true) as
select project_id,
       report_date,
       count(*)::integer as report_count,
       max(submitted_at) as last_submitted_at
  from dpr_reports
 where deleted_at is null and status in ('submitted', 'reviewed')
 group by project_id, report_date;

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('supervisor', 'dpr.report.create'), ('project_manager', 'dpr.report.create'),
    -- The action part of a permission code allows letters, digits and underscores, so the spec's
    -- update-own is spelled update_own.
    ('supervisor', 'dpr.report.update_own'), ('project_manager', 'dpr.report.update_own'),
    ('supervisor', 'dpr.report.read'), ('project_manager', 'dpr.report.read'),
    ('management', 'dpr.report.read'), ('accountant', 'dpr.report.read'),
    ('project_manager', 'dpr.report.review'), ('management', 'dpr.report.review')
  ) as t (role_code, permission_code);
