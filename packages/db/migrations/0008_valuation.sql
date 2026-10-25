-- P1-13 Stock valuation engine: configurable weighted-average or FIFO valuation.
-- RLS is enabled with no policies (deny-all). Stores and items are opaque keys: no foreign keys to other modules.

create table val_policies (
  id uuid primary key,
  scope text not null check (scope in ('company', 'category')),
  category_id uuid,
  method text not null check (method in ('weighted_average', 'fifo')),
  effective_from date not null,
  status text not null check (status in ('pending_approval', 'active', 'superseded', 'rejected')),
  requested_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  check ((scope = 'company' and category_id is null) or (scope = 'category' and category_id is not null))
);
alter table val_policies enable row level security;
-- BR-3: one active policy per scope key and effective date.
create unique index val_policies_active_uq
  on val_policies (scope, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from)
  where status = 'active';

-- H-07 default (recorded in the PR): company default weighted average, no overrides.
insert into val_policies (id, scope, category_id, method, effective_from, status)
values (md5('val_policy:company:initial')::uuid, 'company', null, 'weighted_average', date '2000-01-01', 'active');

-- The method a (store, item) key is currently kept in; also the lock row for every movement on the key.
create table val_keys (
  store_id uuid not null,
  item_id uuid not null,
  method text not null check (method in ('weighted_average', 'fifo')),
  -- A key never goes back to an earlier policy: its method is resolved at the later of the posting date and this date.
  last_posting_date date,
  created_at timestamptz not null default now(),
  primary key (store_id, item_id)
);
alter table val_keys enable row level security;

create table val_wa_state (
  store_id uuid not null,
  item_id uuid not null,
  quantity numeric(18,4) not null default 0 check (quantity >= 0),
  total_value numeric(18,2) not null default 0 check (total_value >= 0),
  updated_seq bigint not null default 0,
  primary key (store_id, item_id)
);
alter table val_wa_state enable row level security;

create table val_movements (
  id uuid primary key,
  seq bigserial not null unique,
  store_id uuid not null,
  item_id uuid not null,
  type text not null check (type in ('receipt', 'issue', 'transfer_out', 'transfer_in', 'return', 'transition')),
  quantity numeric(18,4) not null check (quantity >= 0),
  value numeric(18,2) not null check (value >= 0),
  unit_cost numeric(18,4) not null check (unit_cost >= 0),
  method_used text not null check (method_used in ('weighted_average', 'fifo')),
  posting_date date not null,
  source_ref text,
  -- A return points at the issue it gives back.
  issue_movement_id uuid references val_movements (id),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  created_by uuid
);
alter table val_movements enable row level security;
create index val_movements_key_idx on val_movements (store_id, item_id, seq);

create table val_layers (
  id uuid primary key,
  store_id uuid not null,
  item_id uuid not null,
  receipt_ref text,
  received_seq bigint not null,
  remaining_qty numeric(18,4) not null check (remaining_qty >= 0),
  -- BR-5: the value of the layer is tracked beside its quantity so that it never drifts.
  remaining_value numeric(18,2) not null check (remaining_value >= 0),
  unit_cost numeric(18,4) not null check (unit_cost >= 0),
  original_qty numeric(18,4) not null check (original_qty > 0),
  created_at timestamptz not null default now()
);
alter table val_layers enable row level security;
create index val_layers_key_idx on val_layers (store_id, item_id, received_seq) where remaining_qty > 0;

-- One row per part of an issue: a FIFO layer, or the whole issue for weighted average (layer_id null).
create table val_consumptions (
  id uuid primary key,
  movement_id uuid not null references val_movements (id),
  part_no integer not null,
  layer_id uuid references val_layers (id),
  layer_received_seq bigint,
  quantity numeric(18,4) not null check (quantity > 0),
  unit_cost numeric(18,4) not null check (unit_cost >= 0),
  value numeric(18,2) not null check (value >= 0),
  unique (movement_id, part_no)
);
alter table val_consumptions enable row level security;

-- BR-9: how much of each consumed part a return has given back.
create table val_return_parts (
  id uuid primary key,
  movement_id uuid not null references val_movements (id),
  consumption_id uuid not null references val_consumptions (id),
  quantity numeric(18,4) not null check (quantity > 0),
  value numeric(18,2) not null check (value >= 0)
);
alter table val_return_parts enable row level security;
create index val_return_parts_consumption_idx on val_return_parts (consumption_id);

create table val_transitions (
  id uuid primary key,
  store_id uuid not null,
  item_id uuid not null,
  from_method text not null check (from_method in ('weighted_average', 'fifo')),
  to_method text not null check (to_method in ('weighted_average', 'fifo')),
  qty numeric(18,4) not null,
  value_before numeric(18,2) not null,
  value_after numeric(18,2) not null,
  policy_id uuid not null references val_policies (id),
  completed_at timestamptz not null,
  -- BR-11: a key changes over once per policy change.
  unique (store_id, item_id, policy_id)
);
alter table val_transitions enable row level security;

-- BR-14: movements and consumptions are append-only.
create function val_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;
create trigger val_movements_no_change before update or delete on val_movements
  for each row execute function val_append_only();
create trigger val_movements_no_truncate before truncate on val_movements
  execute function val_append_only();
create trigger val_consumptions_no_change before update or delete on val_consumptions
  for each row execute function val_append_only();
create trigger val_consumptions_no_truncate before truncate on val_consumptions
  execute function val_append_only();
create trigger val_return_parts_no_change before update or delete on val_return_parts
  for each row execute function val_append_only();
create trigger val_return_parts_no_truncate before truncate on val_return_parts
  execute function val_append_only();

-- BR-3 / H-09: the owner (management role) approves policy changes.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:valuation_policy')::uuid, 'valuation_policy', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:valuation_policy')::uuid, 1, 'management', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'valuation.policy.read'), ('accountant', 'valuation.policy.read'),
    ('management', 'valuation.policy.read'), ('storekeeper', 'valuation.policy.read'),
    ('accountant', 'valuation.policy.request'),
    ('accountant', 'valuation.transition.run'), ('admin', 'valuation.transition.run'),
    ('admin', 'valuation.report.read'), ('accountant', 'valuation.report.read'),
    ('management', 'valuation.report.read')
  ) as t (role_code, permission_code);
