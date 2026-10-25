-- P1-06 CRM and leads: enquiries from first contact to won or lost.
-- RLS is enabled with no policies (deny-all). Stages, sources and loss reasons are editable reference data (H-16 defaults).

create table crm_stages (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{0,31}$'),
  name text not null check (btrim(name) <> ''),
  sort_order integer not null,
  kind text not null check (kind in ('open', 'won', 'lost')),
  active boolean not null default true
);
alter table crm_stages enable row level security;

create table crm_sources (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{0,31}$'),
  name text not null check (btrim(name) <> '')
);
alter table crm_sources enable row level security;

create table crm_loss_reasons (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{0,31}$'),
  name text not null check (btrim(name) <> '')
);
alter table crm_loss_reasons enable row level security;

create table crm_leads (
  id uuid primary key,
  number text not null unique,
  party_id uuid,
  contact_name text,
  contact_phone text check (contact_phone is null or contact_phone ~ '^\+92[1-9][0-9]{8,9}$'),
  work_type text not null check (work_type in
    ('new_build', 'boundary_wall', 'renovation', 'demolition', 'restructure', 'maintenance', 'other')),
  sector text not null check (sector in ('government', 'private')),
  location_id uuid,
  site_address text,
  description text,
  expected_value numeric(18,2) check (expected_value is null or expected_value >= 0),
  source_code text not null references crm_sources (code),
  stage_code text not null references crm_stages (code),
  owner_user_id uuid not null,
  loss_reason_code text references crm_loss_reasons (code),
  won_at timestamptz,
  lost_at timestamptz,
  -- BR-8: the won event is emitted once per lead, even if the lead is reopened and won again.
  won_event_emitted boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  -- BR-1
  check (party_id is not null or (contact_name is not null and contact_phone is not null))
);
alter table crm_leads enable row level security;
create index crm_leads_stage_idx on crm_leads (stage_code) where deleted_at is null;
create index crm_leads_owner_idx on crm_leads (owner_user_id) where deleted_at is null;

create table crm_site_visits (
  id uuid primary key,
  lead_id uuid not null references crm_leads (id),
  visit_date date not null,
  visited_by uuid not null,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table crm_site_visits enable row level security;
create index crm_site_visits_lead_idx on crm_site_visits (lead_id);

create table crm_follow_ups (
  id uuid primary key,
  lead_id uuid not null references crm_leads (id),
  due_date date not null,
  note text,
  assigned_to uuid not null,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table crm_follow_ups enable row level security;
-- BR-4: at most one open follow-up per lead, assignee and due date.
create unique index crm_follow_ups_open_uq
  on crm_follow_ups (lead_id, assigned_to, due_date) where status = 'open';
create index crm_follow_ups_due_idx on crm_follow_ups (due_date) where status = 'open';

-- Append-only (constitution 5.11).
create table crm_stage_history (
  id bigserial primary key,
  lead_id uuid not null references crm_leads (id),
  from_stage text,
  to_stage text not null,
  at timestamptz not null,
  by uuid
);
alter table crm_stage_history enable row level security;
create index crm_stage_history_lead_idx on crm_stage_history (lead_id, id);

insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('lead', 'LEAD', 4, false, false, 1, 1);

-- H-16 (default allowed): stages, generic sources and loss reasons; all editable.
insert into crm_stages (code, name, sort_order, kind) values
  ('new', 'New', 1, 'open'), ('visited', 'Visited', 2, 'open'), ('quoted', 'Quoted', 3, 'open'),
  ('negotiation', 'Negotiation', 4, 'open'), ('won', 'Won', 5, 'won'), ('lost', 'Lost', 6, 'lost');
insert into crm_sources (code, name) values
  ('referral', 'Referral'), ('walk_in', 'Walk-in'), ('phone', 'Phone call'),
  ('website', 'Website'), ('repeat_client', 'Repeat client'), ('tender', 'Tender notice'),
  ('other', 'Other');
insert into crm_loss_reasons (code, name) values
  ('price', 'Price too high'), ('competitor', 'Lost to a competitor'),
  ('no_response', 'Client stopped responding'), ('cancelled', 'Client cancelled the work'),
  ('out_of_scope', 'Outside our scope'), ('other', 'Other');

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'crm.lead.read'), ('management', 'crm.lead.read'), ('project_manager', 'crm.lead.read'),
    ('service_coordinator', 'crm.lead.read'), ('accountant', 'crm.lead.read'),
    ('admin', 'crm.lead.create'), ('management', 'crm.lead.create'),
    ('project_manager', 'crm.lead.create'), ('service_coordinator', 'crm.lead.create'),
    ('admin', 'crm.lead.update'), ('management', 'crm.lead.update'),
    ('project_manager', 'crm.lead.update'), ('service_coordinator', 'crm.lead.update'),
    ('admin', 'crm.lead.reopen'), ('management', 'crm.lead.reopen'),
    ('admin', 'crm.visit.manage'), ('management', 'crm.visit.manage'),
    ('project_manager', 'crm.visit.manage'), ('service_coordinator', 'crm.visit.manage'),
    ('admin', 'crm.followup.manage'), ('management', 'crm.followup.manage'),
    ('project_manager', 'crm.followup.manage'), ('service_coordinator', 'crm.followup.manage')
  ) as t (role_code, permission_code);
