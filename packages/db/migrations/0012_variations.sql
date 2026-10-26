-- P1-10 Project variations: changes in scope with client approval. RLS is enabled with no policies
-- (deny-all). Projects, cost codes and users are opaque keys: no foreign keys to other modules.

create table var_variations (
  id uuid primary key,
  project_id uuid not null,
  -- BR-1: numbers run per project, printed `<project code>-V<seq>`.
  seq integer not null check (seq > 0),
  number text not null unique,
  title text not null check (btrim(title) <> ''),
  reason text not null default '',
  discovered_on date not null,
  status text not null default 'draft' check (status in
    ('draft', 'pending_internal_approval', 'submitted_to_client', 'client_approved',
     'client_rejected', 'cancelled')),
  -- BR-2: the sums of the line amounts; the price impact may be negative (deductive variation).
  price_impact numeric(18,2) not null default 0,
  cost_impact numeric(18,2) not null default 0,
  client_approval_ref text,
  client_approved_on date,
  -- BR-7: the draft a rejected variation was copied from.
  copied_from_id uuid references var_variations (id),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (project_id, seq),
  check (status <> 'client_approved' or (client_approval_ref is not null and client_approved_on is not null))
);
alter table var_variations enable row level security;
create index var_variations_project_idx on var_variations (project_id) where deleted_at is null;
create index var_variations_status_idx on var_variations (status) where deleted_at is null;

create table var_lines (
  id uuid primary key,
  variation_id uuid not null references var_variations (id),
  line_no integer not null check (line_no > 0),
  description text not null check (btrim(description) <> ''),
  cost_code_id uuid not null,
  cost_amount numeric(18,2) not null,
  price_amount numeric(18,2) not null,
  unique (variation_id, line_no)
);
alter table var_lines enable row level security;

-- Next number per project, taken with a row lock inside the transaction that inserts the variation.
create table var_counters (
  project_id uuid primary key,
  last_seq integer not null
);
alter table var_counters enable row level security;

-- One row per status change (the approval timeline); append-only.
create table var_status_history (
  id uuid primary key,
  variation_id uuid not null references var_variations (id),
  from_status text,
  to_status text not null,
  at timestamptz not null,
  changed_by uuid,
  note text
);
alter table var_status_history enable row level security;
create index var_status_history_variation_idx on var_status_history (variation_id, at);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('management', 'variations.variation.read'), ('project_manager', 'variations.variation.read'),
    ('management', 'variations.variation.create'), ('project_manager', 'variations.variation.create'),
    ('supervisor', 'variations.variation.create'),
    ('management', 'variations.variation.update'), ('project_manager', 'variations.variation.update'),
    ('management', 'variations.variation.client_approve'),
    ('project_manager', 'variations.variation.client_approve')
  ) as t (role_code, permission_code);
