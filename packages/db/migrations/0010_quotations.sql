-- P1-08 Quotations (lump sum): quotations, their payment-stage schedule and status history.
-- RLS is enabled with no policies (deny-all). Leads, estimates, parties and locations are opaque
-- keys: no foreign keys to other modules.

create table qte_quotations (
  id uuid primary key,
  number text not null,
  -- The revision of the quotation (1, 2, ...); `version` below is the concurrency counter (constitution 5.2).
  revision integer not null default 1 check (revision > 0),
  parent_id uuid references qte_quotations (id),
  lead_id uuid,
  estimate_id uuid not null,
  party_id uuid not null,
  title text not null check (btrim(title) <> ''),
  sector text not null check (sector in ('government', 'private')),
  location_id uuid,
  scope_text text not null default '',
  inclusions text not null default '',
  exclusions text not null default '',
  terms text not null default '',
  validity_days integer not null check (validity_days between 1 and 365),
  price numeric(18,2) not null check (price > 0),
  status text not null default 'draft' check (status in
    ('draft', 'pending_approval', 'approved', 'issued', 'accepted', 'rejected', 'expired', 'superseded')),
  issued_at timestamptz,
  accepted_at timestamptz,
  accepted_by_name text,
  expires_on date,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (number, revision)
);
alter table qte_quotations enable row level security;
create index qte_quotations_status_idx on qte_quotations (status) where deleted_at is null;
create index qte_quotations_party_idx on qte_quotations (party_id) where deleted_at is null;
create index qte_quotations_lead_idx on qte_quotations (lead_id) where deleted_at is null;
create index qte_quotations_estimate_idx on qte_quotations (estimate_id) where deleted_at is null;
-- BR-4: a quotation has at most one open (not yet issued) revision.
create unique index qte_quotations_open_revision_uq on qte_quotations (parent_id)
  where status in ('draft', 'pending_approval', 'approved') and deleted_at is null and parent_id is not null;

create table qte_stages (
  id uuid primary key,
  quotation_id uuid not null references qte_quotations (id),
  stage_no integer not null check (stage_no > 0),
  name text not null check (btrim(name) <> ''),
  basis text not null check (basis in ('percent', 'amount')),
  percent numeric(9,4) not null check (percent > 0 and percent <= 100),
  amount numeric(18,2) not null check (amount >= 0),
  condition_text text,
  unique (quotation_id, stage_no)
);
alter table qte_stages enable row level security;

-- Append-only: one row per status change; `changed_by` is null for the daily expiry job.
create table qte_status_history (
  id uuid primary key,
  quotation_id uuid not null references qte_quotations (id),
  from_status text,
  to_status text not null,
  at timestamptz not null,
  changed_by uuid,
  note text
);
alter table qte_status_history enable row level security;
create index qte_status_history_quotation_idx on qte_status_history (quotation_id, at);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('management', 'quotations.quotation.read'), ('project_manager', 'quotations.quotation.read'),
    ('accountant', 'quotations.quotation.read'),
    ('management', 'quotations.quotation.create'), ('project_manager', 'quotations.quotation.create'),
    ('management', 'quotations.quotation.update'), ('project_manager', 'quotations.quotation.update'),
    ('management', 'quotations.quotation.submit'), ('project_manager', 'quotations.quotation.submit'),
    ('management', 'quotations.quotation.issue'), ('project_manager', 'quotations.quotation.issue'),
    ('management', 'quotations.quotation.accept'), ('project_manager', 'quotations.quotation.accept'),
    ('management', 'quotations.quotation.reject'), ('project_manager', 'quotations.quotation.reject'),
    ('management', 'quotations.margin.read'), ('accountant', 'quotations.margin.read')
  ) as t (role_code, permission_code);
