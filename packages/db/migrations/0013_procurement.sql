-- P1-11 Procurement: requisitions, quote comparison, purchase orders and goods receipts. RLS is
-- enabled with no policies (deny-all). Projects, stores, items, vendors, cost codes and users are
-- opaque keys: no foreign keys to other modules.

-- Next number per kind and year (`REQ-2026-0001`), taken with a row lock inside the inserting
-- transaction. Purchase orders use the platform series `purchase_order` (H-27).
create table prc_counters (
  kind text not null check (kind in ('requisition', 'rfq', 'grn')),
  year integer not null,
  last_seq integer not null,
  primary key (kind, year)
);
alter table prc_counters enable row level security;

create table prc_requisitions (
  id uuid primary key,
  number text not null unique,
  project_id uuid,
  store_id uuid,
  requested_by uuid not null,
  required_by date,
  status text not null default 'draft' check (status in
    ('draft', 'pending_approval', 'approved', 'rejected', 'partly_ordered', 'ordered', 'cancelled')),
  note text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  -- BR-1: a project (direct to site) or a store (replenishment), never both, never neither.
  check ((project_id is null) <> (store_id is null))
);
alter table prc_requisitions enable row level security;
create index prc_requisitions_project_idx on prc_requisitions (project_id) where deleted_at is null;
create index prc_requisitions_status_idx on prc_requisitions (status) where deleted_at is null;

create table prc_requisition_lines (
  id uuid primary key,
  requisition_id uuid not null references prc_requisitions (id),
  line_no integer not null check (line_no > 0),
  item_id uuid not null,
  description text not null default '',
  quantity numeric(18,4) not null check (quantity > 0),
  unit_code text not null,
  cost_code_id uuid not null,
  estimated_rate numeric(18,4) check (estimated_rate is null or estimated_rate >= 0),
  unique (requisition_id, line_no)
);
alter table prc_requisition_lines enable row level security;

create table prc_rfqs (
  id uuid primary key,
  requisition_id uuid not null references prc_requisitions (id),
  number text not null unique,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table prc_rfqs enable row level security;
create index prc_rfqs_requisition_idx on prc_rfqs (requisition_id) where deleted_at is null;

create table prc_rfq_vendors (
  rfq_id uuid not null references prc_rfqs (id),
  vendor_id uuid not null,
  primary key (rfq_id, vendor_id)
);
alter table prc_rfq_vendors enable row level security;

create table prc_quotes (
  id uuid primary key,
  rfq_id uuid not null references prc_rfqs (id),
  vendor_id uuid not null,
  valid_until date,
  delivery_days integer check (delivery_days is null or delivery_days >= 0),
  terms text not null default '',
  total numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table prc_quotes enable row level security;
-- One live quote per vendor per RFQ; a vendor re-quotes by updating it.
create unique index prc_quotes_vendor_idx on prc_quotes (rfq_id, vendor_id) where deleted_at is null;

create table prc_quote_lines (
  quote_id uuid not null references prc_quotes (id),
  requisition_line_id uuid not null references prc_requisition_lines (id),
  rate numeric(18,4) not null check (rate >= 0),
  primary key (quote_id, requisition_line_id)
);
alter table prc_quote_lines enable row level security;

create table prc_selections (
  rfq_id uuid not null references prc_rfqs (id),
  requisition_line_id uuid not null references prc_requisition_lines (id),
  quote_id uuid not null references prc_quotes (id),
  reason text,
  primary key (rfq_id, requisition_line_id)
);
alter table prc_selections enable row level security;

create table prc_purchase_orders (
  id uuid primary key,
  number text not null unique,
  -- BR-5: the document version, raised by every amendment (the base `version` is concurrency).
  revision integer not null default 1 check (revision > 0),
  vendor_id uuid not null,
  requisition_id uuid references prc_requisitions (id),
  project_id uuid,
  store_id uuid,
  destination_type text not null check (destination_type in ('project', 'store')),
  order_date date not null,
  expected_date date,
  status text not null default 'draft' check (status in
    ('draft', 'pending_approval', 'approved', 'partly_received', 'received', 'closed', 'cancelled')),
  total numeric(18,2) not null default 0,
  terms text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check ((destination_type = 'project' and project_id is not null and store_id is null)
      or (destination_type = 'store' and store_id is not null and project_id is null))
);
alter table prc_purchase_orders enable row level security;
create index prc_purchase_orders_status_idx on prc_purchase_orders (status) where deleted_at is null;
create index prc_purchase_orders_project_idx on prc_purchase_orders (project_id) where deleted_at is null;

create table prc_po_lines (
  id uuid primary key,
  po_id uuid not null references prc_purchase_orders (id),
  line_no integer not null check (line_no > 0),
  requisition_line_id uuid references prc_requisition_lines (id),
  item_id uuid not null,
  description text not null default '',
  quantity numeric(18,4) not null check (quantity > 0),
  unit_code text not null,
  rate numeric(18,4) not null check (rate >= 0),
  line_total numeric(18,2) not null,
  cost_code_id uuid not null,
  received_qty numeric(18,4) not null default 0 check (received_qty >= 0),
  -- BR-5: a line dropped by an amendment keeps its commitment until the amendment is approved.
  removed boolean not null default false,
  -- The live committed cost entry of this line (an opaque key into the project cost ledger) and a
  -- counter that keeps the idempotency keys of successive commitments apart.
  commit_entry_id uuid,
  commit_seq integer not null default 0
);
alter table prc_po_lines enable row level security;
-- Line numbers are unique among the lines that are on the order; removed lines keep their old number.
create unique index prc_po_lines_number_idx on prc_po_lines (po_id, line_no) where removed = false;

create table prc_grns (
  id uuid primary key,
  number text not null unique,
  po_id uuid not null references prc_purchase_orders (id),
  received_on date not null,
  received_by uuid not null,
  delivery_note_ref text,
  status text not null default 'posted' check (status in ('posted', 'cancelled')),
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table prc_grns enable row level security;
create index prc_grns_po_idx on prc_grns (po_id) where deleted_at is null;

create table prc_grn_lines (
  id uuid primary key,
  grn_id uuid not null references prc_grns (id),
  po_line_id uuid not null references prc_po_lines (id),
  accepted_qty numeric(18,4) not null check (accepted_qty >= 0),
  rejected_qty numeric(18,4) not null default 0 check (rejected_qty >= 0),
  note text not null default '',
  -- BR-7: the accepted quantity at the order rate, and the approved cost entry it produced (project
  -- destinations only).
  cost_amount numeric(18,2) not null default 0,
  cost_entry_id uuid,
  unique (grn_id, po_line_id)
);
alter table prc_grn_lines enable row level security;

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('supervisor', 'procurement.requisition.create'), ('project_manager', 'procurement.requisition.create'),
    ('storekeeper', 'procurement.requisition.create'), ('procurement', 'procurement.requisition.create'),
    ('supervisor', 'procurement.requisition.read'), ('project_manager', 'procurement.requisition.read'),
    ('storekeeper', 'procurement.requisition.read'), ('procurement', 'procurement.requisition.read'),
    ('management', 'procurement.requisition.read'),
    ('procurement', 'procurement.rfq.manage'),
    ('procurement', 'procurement.po.create'),
    ('procurement', 'procurement.po.read'), ('management', 'procurement.po.read'),
    ('procurement', 'procurement.po.amend'),
    ('procurement', 'procurement.po.close'),
    ('storekeeper', 'procurement.grn.create'), ('supervisor', 'procurement.grn.create'),
    ('storekeeper', 'procurement.grn.read'), ('supervisor', 'procurement.grn.read'),
    ('procurement', 'procurement.grn.read'), ('management', 'procurement.grn.read'),
    ('storekeeper', 'procurement.grn.cancel'), ('supervisor', 'procurement.grn.cancel')
  ) as t (role_code, permission_code);
