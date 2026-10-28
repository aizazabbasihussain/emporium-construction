-- P1-12 Inventory core: stores, the append-only stock ledger, balances, transfers, counts and reorder
-- levels. RLS is enabled with no policies (deny-all). Items, projects, parties and users are opaque
-- keys of other modules: no foreign keys to them.

create table inv_stores (
  id uuid primary key,
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  kind text not null check (kind in ('warehouse', 'site')),
  project_id uuid,
  custodian_user_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  -- a warehouse belongs to no project
  check (kind = 'site' or project_id is null)
);
alter table inv_stores enable row level security;
create index inv_stores_project_idx on inv_stores (project_id) where project_id is not null;

-- Append-only (constitution 5.11). `seq` is the posting sequence (BR-9). The quantity is signed;
-- `value` is a magnitude and null for client-owned stock.
create table inv_ledger (
  id uuid primary key,
  seq bigint generated always as identity,
  store_id uuid not null references inv_stores (id),
  item_id uuid not null,
  ownership text not null check (ownership in ('company', 'client')),
  owner_party_id uuid,
  movement_type text not null check (movement_type in
    ('receipt', 'issue', 'transfer_out', 'transfer_in', 'adjustment_in', 'adjustment_out',
     'return_in', 'salvage_in', 'client_receipt', 'client_return')),
  quantity numeric(18,4) not null check (quantity <> 0),
  unit_cost numeric(18,4),
  value numeric(18,2),
  cost_object_type text check (cost_object_type in ('project', 'work_order', 'overhead')),
  cost_object_id uuid,
  source_doc_type text not null check (btrim(source_doc_type) <> ''),
  source_doc_id uuid not null,
  source_line_id uuid,
  business_date date not null,
  posted_at timestamptz not null default now(),
  idempotency_key text not null unique check (btrim(idempotency_key) <> ''),
  reverses_id uuid references inv_ledger (id),
  created_by uuid,
  -- BR-5: client stock has an owner and no cost; company stock has no owner.
  check ((ownership = 'client') = (owner_party_id is not null)),
  check (ownership = 'company' or (unit_cost is null and value is null)),
  -- the sign follows the movement type
  check ((movement_type in ('receipt', 'transfer_in', 'adjustment_in', 'return_in', 'salvage_in', 'client_receipt')) = (quantity > 0))
);
alter table inv_ledger enable row level security;
create index inv_ledger_key_idx on inv_ledger (store_id, item_id, ownership, seq);
create index inv_ledger_source_idx on inv_ledger (source_doc_type, source_doc_id);
create index inv_ledger_cost_object_idx on inv_ledger (cost_object_type, cost_object_id)
  where cost_object_id is not null;

create function inv_ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'inv_ledger is append-only' using errcode = 'restrict_violation';
end;
$$;
create trigger inv_ledger_no_change
  before update or delete on inv_ledger
  for each row execute function inv_ledger_append_only();
create trigger inv_ledger_no_truncate
  before truncate on inv_ledger
  for each statement execute function inv_ledger_append_only();

-- Maintained in the same transaction as the ledger; the row is the lock of BR-11. Owner is null for
-- company stock, so the key is unique through an index on the coalesced owner.
create table inv_balances (
  id uuid primary key,
  store_id uuid not null references inv_stores (id),
  item_id uuid not null,
  ownership text not null check (ownership in ('company', 'client')),
  owner_party_id uuid,
  quantity numeric(18,4) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  check ((ownership = 'client') = (owner_party_id is not null))
);
alter table inv_balances enable row level security;
create unique index inv_balances_key_idx
  on inv_balances (store_id, item_id, ownership, coalesce(owner_party_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- BR-3 and BR-6: what each issue took and what has come back, so a return can be checked and its
-- project cost restated. `cost_entry_id` is the live project cost entry of the issue.
create table inv_issues (
  id uuid primary key,
  store_id uuid not null references inv_stores (id),
  item_id uuid not null,
  ownership text not null check (ownership in ('company', 'client')),
  owner_party_id uuid,
  quantity numeric(18,4) not null check (quantity > 0),
  returned_quantity numeric(18,4) not null default 0 check (returned_quantity >= 0 and returned_quantity <= quantity),
  value numeric(18,2),
  returned_value numeric(18,2) not null default 0,
  cost_object_type text not null check (cost_object_type in ('project', 'work_order', 'overhead')),
  cost_object_id uuid,
  cost_code_id uuid,
  valuation_movement_id uuid,
  cost_entry_id uuid,
  business_date date not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  check ((ownership = 'client') = (owner_party_id is not null))
);
alter table inv_issues enable row level security;
create index inv_issues_store_item_idx on inv_issues (store_id, item_id);

create table inv_transfers (
  id uuid primary key,
  number text not null unique,
  from_store_id uuid not null references inv_stores (id),
  to_store_id uuid not null references inv_stores (id),
  status text not null default 'draft' check (status in ('draft', 'in_transit', 'received', 'cancelled')),
  business_date date not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (from_store_id <> to_store_id)
);
alter table inv_transfers enable row level security;

create table inv_transfer_lines (
  id uuid primary key,
  transfer_id uuid not null references inv_transfers (id),
  item_id uuid not null,
  ownership text not null check (ownership in ('company', 'client')),
  owner_party_id uuid,
  project_id uuid,
  quantity numeric(18,4) not null check (quantity > 0),
  check ((ownership = 'client') = (owner_party_id is not null))
);
alter table inv_transfer_lines enable row level security;
create index inv_transfer_lines_transfer_idx on inv_transfer_lines (transfer_id);

create table inv_counts (
  id uuid primary key,
  number text not null unique,
  store_id uuid not null references inv_stores (id),
  status text not null default 'draft' check (status in ('draft', 'counted', 'approved', 'cancelled')),
  counted_on date not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table inv_counts enable row level security;

create table inv_count_lines (
  id uuid primary key,
  count_id uuid not null references inv_counts (id),
  item_id uuid not null,
  ownership text not null check (ownership in ('company', 'client')),
  owner_party_id uuid,
  system_qty numeric(18,4) not null check (system_qty >= 0),
  counted_qty numeric(18,4) not null check (counted_qty >= 0),
  check ((ownership = 'client') = (owner_party_id is not null))
);
alter table inv_count_lines enable row level security;
create index inv_count_lines_count_idx on inv_count_lines (count_id);

-- BR-10: `alerted` is true from the alert until the balance is back at or above the level.
create table inv_reorder_levels (
  store_id uuid not null references inv_stores (id),
  item_id uuid not null,
  level numeric(18,4) not null check (level >= 0),
  alerted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (store_id, item_id)
);
alter table inv_reorder_levels enable row level security;

-- Published reads for other modules (constitution 3.3).
create view inv_v_stock_on_hand with (security_invoker = true) as
select store_id, item_id, ownership, owner_party_id, quantity
  from inv_balances;

-- BR-5: client material per project and store, in quantities only.
create view inv_v_client_material_balance with (security_invoker = true) as
select cost_object_id as project_id,
       store_id,
       item_id,
       owner_party_id,
       coalesce(sum(quantity) filter (where movement_type = 'client_receipt'), 0)::numeric(18,4) as received_qty,
       coalesce(-sum(quantity) filter (where movement_type = 'issue'), 0)::numeric(18,4) as used_qty,
       coalesce(-sum(quantity) filter (where movement_type = 'client_return'), 0)::numeric(18,4) as returned_qty,
       coalesce(sum(quantity), 0)::numeric(18,4) as balance_qty
  from inv_ledger
 where ownership = 'client' and cost_object_type = 'project'
 group by cost_object_id, store_id, item_id, owner_party_id;

insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('stock_transfer', 'STR', 4, true, false, 1, 1),
       ('stock_count', 'CNT', 4, true, false, 1, 1);

-- BR-8 / H-09: the owner (management role) approves count adjustments.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:stock_adjustment')::uuid, 'stock_adjustment', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:stock_adjustment')::uuid, 1, 'management', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('storekeeper', 'inventory.stock.read'), ('procurement', 'inventory.stock.read'),
    ('project_manager', 'inventory.stock.read'), ('management', 'inventory.stock.read'),
    ('accountant', 'inventory.stock.read'), ('supervisor', 'inventory.stock.read'),
    ('storekeeper', 'inventory.stock.issue'),
    ('storekeeper', 'inventory.stock.return'),
    ('storekeeper', 'inventory.stock.transfer'),
    ('storekeeper', 'inventory.stock.count'),
    ('management', 'inventory.adjustment.approve'),
    ('admin', 'inventory.store.manage'), ('storekeeper', 'inventory.store.manage')
  ) as t (role_code, permission_code);
