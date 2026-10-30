-- P1-19 Operational reports: saved filters only. Every report is a query composition over the
-- exported interfaces of the other modules, so nothing else is stored here.
create table rpt_saved_filters (
  id uuid primary key,
  user_id uuid not null,
  report_code text not null check (report_code in
    ('project-cost', 'stock', 'purchasing', 'labour', 'dpr-compliance', 'pipeline', 'client-material')),
  name text not null check (length(btrim(name)) between 1 and 100),
  filter jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table rpt_saved_filters enable row level security;
create unique index rpt_saved_filters_name_idx
  on rpt_saved_filters (user_id, report_code, lower(name)) where deleted_at is null;

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('management', 'reports.project_cost.read'), ('project_manager', 'reports.project_cost.read'),
    ('accountant', 'reports.project_cost.read'),
    ('storekeeper', 'reports.stock.read'), ('procurement', 'reports.stock.read'),
    ('management', 'reports.stock.read'), ('accountant', 'reports.stock.read'),
    ('procurement', 'reports.purchasing.read'), ('management', 'reports.purchasing.read'),
    ('management', 'reports.labour.read'), ('accountant', 'reports.labour.read'),
    ('project_manager', 'reports.dpr.read'), ('management', 'reports.dpr.read'),
    ('management', 'reports.pipeline.read'), ('project_manager', 'reports.pipeline.read')
  ) as t (role_code, permission_code);
