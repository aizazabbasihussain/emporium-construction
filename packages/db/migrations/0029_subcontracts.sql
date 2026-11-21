-- P2-06 Subcontractor orders and payments. RLS is enabled with no policies (deny-all).
-- Projects, parties, cost codes, cost entries, bills and users are opaque keys: no foreign keys to
-- other modules.

create table sub_work_orders (
  id uuid primary key,
  number text not null,
  project_id uuid not null,
  party_id uuid not null,
  title text not null check (btrim(title) <> ''),
  scope_text text not null default '',
  contract_amount numeric(18,2) not null check (contract_amount > 0),
  cost_code_id uuid not null,
  start_date date,
  end_date date,
  status text not null default 'draft' check (status in
    ('draft', 'pending_approval', 'active', 'completed', 'closed', 'cancelled')),
  -- BR-8: retention is out of scope; the column is reserved and must stay zero.
  retention_percent numeric(9,4) not null default 0 check (retention_percent = 0),
  -- The live commitment on the project's cost ledger: its entry and the amount still committed.
  commitment_entry_id uuid,
  commitment_amount numeric(18,2) not null default 0 check (commitment_amount >= 0),
  closed_on date,
  close_reason text,
  cancelled_on date,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (number),
  check (end_date is null or start_date is null or end_date >= start_date)
);
alter table sub_work_orders enable row level security;
create index sub_work_orders_project_idx on sub_work_orders (project_id, status);
create index sub_work_orders_party_idx on sub_work_orders (party_id);

create table sub_work_order_variations (
  id uuid primary key,
  work_order_id uuid not null references sub_work_orders (id),
  seq integer not null check (seq > 0),
  -- Positive adds to the contract, negative reduces it.
  amount numeric(18,2) not null check (amount <> 0),
  reason text not null check (btrim(reason) <> ''),
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  decided_by uuid,
  decided_on date,
  decision_note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (work_order_id, seq)
);
alter table sub_work_order_variations enable row level security;

create table sub_certificates (
  id uuid primary key,
  number text not null,
  work_order_id uuid not null references sub_work_orders (id),
  certificate_date date not null,
  basis text not null check (basis in ('percent_complete', 'amount')),
  cumulative_percent numeric(9,4) not null check (cumulative_percent >= 0),
  cumulative_amount numeric(18,2) not null check (cumulative_amount >= 0),
  this_certificate_amount numeric(18,2) not null check (this_certificate_amount >= 0),
  deductions numeric(18,2) not null default 0 check (deductions >= 0),
  net_certified numeric(18,2) not null check (net_certified >= 0),
  status text not null default 'draft' check (status in
    ('draft', 'pending_approval', 'certified', 'billed', 'cancelled')),
  certified_by uuid,
  certified_on date,
  notes text,
  -- The approved cost entry of the gross certified amount (BR-4) and the bill built from it (BR-5).
  gross_entry_id uuid,
  bill_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (number)
);
alter table sub_certificates enable row level security;
create index sub_certificates_order_idx on sub_certificates (work_order_id, status);

create table sub_back_charges (
  id uuid primary key,
  work_order_id uuid not null references sub_work_orders (id),
  certificate_id uuid references sub_certificates (id),
  description text not null check (btrim(description) <> ''),
  amount numeric(18,2) not null check (amount > 0),
  -- BR-4: a back-charge that recovers a cost the company incurred offsets that cost on the project.
  recovers_cost boolean not null default false,
  cost_code_id uuid,
  entry_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (not recovers_cost or cost_code_id is not null)
);
alter table sub_back_charges enable row level security;
create index sub_back_charges_order_idx on sub_back_charges (work_order_id);
create index sub_back_charges_certificate_idx on sub_back_charges (certificate_id);

insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('subcontract_order', 'SCO', 4, true, false, 1, 1),
       ('subcontract_certificate', 'SCC', 4, true, false, 1, 1);

-- BR-1: the owner approves every subcontract order (H-09); BR-4: the project manager certifies.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:subcontract_order')::uuid, 'subcontract_order', 0, null, date '2026-01-01'),
       (md5('apr_rule:subcontract_certificate')::uuid, 'subcontract_certificate', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:subcontract_order')::uuid, 1, 'management', 1),
       (md5('apr_rule:subcontract_certificate')::uuid, 1, 'project_manager', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'subcontracts.order.read'), ('project_manager', 'subcontracts.order.read'),
    ('management', 'subcontracts.order.read'), ('accountant', 'subcontracts.order.read'),
    ('supervisor', 'subcontracts.order.read'),
    ('admin', 'subcontracts.order.create'), ('project_manager', 'subcontracts.order.create'),
    ('management', 'subcontracts.order.create'),
    ('admin', 'subcontracts.order.update'), ('project_manager', 'subcontracts.order.update'),
    ('management', 'subcontracts.order.update'),
    ('admin', 'subcontracts.order.close'), ('project_manager', 'subcontracts.order.close'),
    ('management', 'subcontracts.order.close'),
    ('admin', 'subcontracts.certificate.create'), ('project_manager', 'subcontracts.certificate.create'),
    ('supervisor', 'subcontracts.certificate.create'),
    ('admin', 'subcontracts.certificate.submit'), ('project_manager', 'subcontracts.certificate.submit'),
    ('admin', 'subcontracts.certificate.bill'), ('accountant', 'subcontracts.certificate.bill'),
    ('admin', 'subcontracts.variation.approve'), ('management', 'subcontracts.variation.approve'),
    ('admin', 'subcontracts.amount.read'), ('management', 'subcontracts.amount.read'),
    ('accountant', 'subcontracts.amount.read'), ('project_manager', 'subcontracts.amount.read')
  ) as t (role_code, permission_code);
