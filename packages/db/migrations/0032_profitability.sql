-- P2-08 Project profitability. Alert settings, saved cost-to-complete forecasts and alert state only:
-- every financial figure is read from the owning modules when asked (BR-6, AC-3). RLS is enabled with
-- no policies (deny-all); projects and users are opaque keys.

create table pft_thresholds (
  id uuid primary key,
  scope text not null check (scope in ('company', 'project')),
  project_id uuid,
  margin_floor_percent numeric(9,4) not null check (margin_floor_percent between 0 and 100),
  overspend_percent numeric(9,4) not null check (overspend_percent between 0 and 1000),
  receivable_age_days integer not null check (receivable_age_days >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check ((scope = 'company') = (project_id is null))
);
alter table pft_thresholds enable row level security;
-- One live company row and one live row per project.
create unique index pft_thresholds_company_uq on pft_thresholds (scope)
  where scope = 'company' and deleted_at is null;
create unique index pft_thresholds_project_uq on pft_thresholds (project_id)
  where scope = 'project' and deleted_at is null;

-- Each forecast is a new row; the latest one per project is used (the older ones stay as history).
create table pft_forecasts (
  id uuid primary key,
  seq bigint generated always as identity unique,
  project_id uuid not null,
  cost_to_complete numeric(18,2) not null check (cost_to_complete >= 0),
  note text not null default '',
  forecast_date date not null,
  set_by uuid not null,
  created_at timestamptz not null default now()
);
alter table pft_forecasts enable row level security;
create index pft_forecasts_project_idx on pft_forecasts (project_id, forecast_date desc, seq desc);

-- An alert is raised once and cleared when its condition is no longer true (BR-4).
create table pft_alert_state (
  id uuid primary key,
  project_id uuid not null,
  alert_code text not null check (alert_code in ('margin_below_floor', 'overspend', 'receivable_overdue')),
  raised_at timestamptz not null,
  cleared_at timestamptz,
  check (cleared_at is null or cleared_at >= raised_at)
);
alter table pft_alert_state enable row level security;
create unique index pft_alert_state_open_uq on pft_alert_state (project_id, alert_code)
  where cleared_at is null;

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('management', 'profitability.project.read'), ('accountant', 'profitability.project.read'),
    ('project_manager', 'profitability.project.read'), ('admin', 'profitability.project.read'),
    ('project_manager', 'profitability.forecast.set'), ('management', 'profitability.forecast.set'),
    ('admin', 'profitability.forecast.set'),
    ('management', 'profitability.threshold.manage'), ('admin', 'profitability.threshold.manage')
  ) as t (role_code, permission_code);
