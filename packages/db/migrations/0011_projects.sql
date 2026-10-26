-- P1-09 Projects and cost ledger: projects, budget lines, the append-only cost ledger, tasks and
-- supervisor assignments. RLS is enabled with no policies (deny-all). Parties, locations, cost
-- codes, quotations, estimates and users are opaque keys: no foreign keys to other modules.

create table prj_projects (
  id uuid primary key,
  code text not null unique,
  name text not null check (btrim(name) <> ''),
  party_id uuid not null,
  sector text not null check (sector in ('government', 'private')),
  location_id uuid,
  site_address text,
  status text not null default 'planning'
    check (status in ('planning', 'active', 'on_hold', 'completed', 'closed', 'cancelled')),
  start_date date,
  planned_end_date date,
  actual_end_date date,
  -- The original value never changes (BR-1); later changes arrive as variations (P1-10).
  original_contract_value numeric(18,2) not null check (original_contract_value > 0),
  quotation_id uuid,
  estimate_id uuid,
  project_manager_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table prj_projects enable row level security;
-- BR-1: one project per quotation, however often the event is delivered.
create unique index prj_projects_quotation_uq on prj_projects (quotation_id)
  where quotation_id is not null;
create index prj_projects_status_idx on prj_projects (status) where deleted_at is null;
create index prj_projects_party_idx on prj_projects (party_id) where deleted_at is null;

create table prj_budget_lines (
  id uuid primary key,
  project_id uuid not null references prj_projects (id),
  cost_code_id uuid not null,
  description text not null default '',
  budget_amount numeric(18,2) not null check (budget_amount >= 0),
  source text not null check (source in ('estimate', 'manual', 'variation')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table prj_budget_lines enable row level security;
create unique index prj_budget_lines_uq on prj_budget_lines (project_id, cost_code_id, description)
  where deleted_at is null;

-- Append-only (constitution 5.11): `seq` orders the rows; a status change is a new row of the same
-- chain (the source line), and the latest row of a chain is its current state (BR-6).
create table prj_cost_entries (
  id uuid primary key,
  seq bigint generated always as identity unique,
  cost_object_type text not null check (cost_object_type in ('project', 'work_order', 'overhead')),
  cost_object_id uuid,
  cost_code_id uuid not null,
  amount numeric(18,2) not null,
  status text not null check (status in ('committed', 'approved', 'posted', 'reversed')),
  source_module text not null check (btrim(source_module) <> ''),
  source_doc_type text not null check (btrim(source_doc_type) <> ''),
  source_doc_id uuid not null,
  source_line_id uuid,
  chain_key text not null,
  entry_date date not null,
  description text not null default '',
  idempotency_key text not null unique check (btrim(idempotency_key) <> ''),
  reverses_entry_id uuid references prj_cost_entries (id),
  created_at timestamptz not null default now(),
  created_by uuid,
  check ((cost_object_type = 'overhead') = (cost_object_id is null))
);
alter table prj_cost_entries enable row level security;
create index prj_cost_entries_object_idx on prj_cost_entries (cost_object_type, cost_object_id);
create index prj_cost_entries_chain_idx on prj_cost_entries (chain_key, seq);

-- AC-4: no role, including the one the app uses, can edit or delete a ledger row.
create function prj_cost_entries_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'prj_cost_entries is append-only' using errcode = 'restrict_violation';
end;
$$;
create trigger prj_cost_entries_no_change
  before update or delete on prj_cost_entries
  for each row execute function prj_cost_entries_append_only();
create trigger prj_cost_entries_no_truncate
  before truncate on prj_cost_entries
  for each statement execute function prj_cost_entries_append_only();

-- BR-6 and BR-7: the current row of every chain, reversed chains left out, totals per status.
create view prj_v_cost_summary with (security_invoker = true) as
with current_entries as (
  select distinct on (chain_key)
         cost_object_type, cost_object_id, cost_code_id, amount, status
    from prj_cost_entries
   order by chain_key, seq desc
)
select cost_object_type,
       cost_object_id,
       cost_code_id,
       coalesce(sum(amount) filter (where status = 'committed'), 0)::numeric(18,2) as committed,
       coalesce(sum(amount) filter (where status = 'approved'), 0)::numeric(18,2) as approved,
       coalesce(sum(amount) filter (where status = 'posted'), 0)::numeric(18,2) as posted
  from current_entries
 where status <> 'reversed'
 group by cost_object_type, cost_object_id, cost_code_id;

create table prj_tasks (
  id uuid primary key,
  project_id uuid not null references prj_projects (id),
  name text not null check (btrim(name) <> ''),
  assigned_to_user uuid,
  start_date date,
  due_date date,
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  percent_complete integer not null default 0 check (percent_complete between 0 and 100),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (status <> 'done' or percent_complete = 100)
);
alter table prj_tasks enable row level security;
create index prj_tasks_project_idx on prj_tasks (project_id) where deleted_at is null;

-- BR-9: an ended assignment keeps its row, so the history stays.
create table prj_supervisor_assignments (
  project_id uuid not null references prj_projects (id),
  user_id uuid not null,
  from_date date not null,
  to_date date,
  primary key (project_id, user_id, from_date),
  check (to_date is null or to_date >= from_date)
);
alter table prj_supervisor_assignments enable row level security;
create index prj_supervisor_assignments_user_idx on prj_supervisor_assignments (user_id);

-- H-27: project codes continue the paper numbering.
insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('project', 'PRJ', 4, false, false, 1, 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('management', 'projects.project.read'), ('project_manager', 'projects.project.read'),
    ('accountant', 'projects.project.read'), ('supervisor', 'projects.project.read'),
    ('management', 'projects.project.create'), ('project_manager', 'projects.project.create'),
    ('management', 'projects.project.update'), ('project_manager', 'projects.project.update'),
    ('management', 'projects.project.status'), ('project_manager', 'projects.project.status'),
    ('management', 'projects.budget.manage'), ('project_manager', 'projects.budget.manage'),
    ('management', 'projects.task.manage'), ('project_manager', 'projects.task.manage'),
    ('supervisor', 'projects.task.manage'),
    ('management', 'projects.cost.read'), ('project_manager', 'projects.cost.read'),
    ('accountant', 'projects.cost.read')
  ) as t (role_code, permission_code);
