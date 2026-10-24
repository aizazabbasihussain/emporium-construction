-- P1-01 Platform kernel: audit log, number series, outbox, idempotency, settings.
-- RLS is enabled with no policies (deny-all); the API uses a server-side role (constitution 3.6).

create table sys_audit_log (
  id uuid primary key,
  at timestamptz not null default now(),
  actor_user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  request_id text
);
create index sys_audit_log_entity_idx on sys_audit_log (entity_type, entity_id);
create index sys_audit_log_actor_idx on sys_audit_log (actor_user_id);
create index sys_audit_log_at_idx on sys_audit_log (at);
alter table sys_audit_log enable row level security;

-- BR-8: append-only, enforced in the database.
create function sys_audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'sys_audit_log is append-only';
end;
$$;
create trigger sys_audit_log_no_update before update or delete on sys_audit_log
  for each row execute function sys_audit_log_immutable();
create trigger sys_audit_log_no_truncate before truncate on sys_audit_log
  for each statement execute function sys_audit_log_immutable();

create table sys_number_series (
  code text primary key check (code ~ '^[a-z0-9_]+$'),
  prefix text not null check (prefix <> ''),
  padding integer not null check (padding between 1 and 12),
  reset_yearly boolean not null,
  gapless boolean not null default false,
  start_value bigint not null default 1 check (start_value >= 0),
  next_value bigint not null default 1 check (next_value >= 0),
  current_year integer,
  last_allocated_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table sys_number_series enable row level security;

-- H-27: paper series continue from 0001. Prefix, padding and next number stay editable from the UI.
-- H-04 (assumed, not yet confirmed by the accountant): invoices are gapless.
insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values
  ('invoice', 'INV', 4, true, true, 1, 1),
  ('quotation', 'QUO', 4, true, false, 1, 1),
  ('purchase_order', 'PO', 4, true, false, 1, 1),
  ('payment_voucher', 'PV', 4, true, false, 1, 1),
  ('receipt_voucher', 'RV', 4, true, false, 1, 1),
  ('variation', 'VAR', 4, true, false, 1, 1);

create table sys_outbox (
  id uuid primary key,
  type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  failed_at timestamptz
);
create index sys_outbox_pending_idx on sys_outbox (next_attempt_at)
  where dispatched_at is null and failed_at is null;
alter table sys_outbox enable row level security;

create table sys_event_consumptions (
  event_id uuid not null references sys_outbox (id),
  handler text not null,
  consumed_at timestamptz not null default now(),
  unique (event_id, handler)
);
alter table sys_event_consumptions enable row level security;

create table sys_idempotency (
  key text not null,
  user_id uuid not null,
  request_hash text not null,
  response jsonb,
  status_code integer not null,
  created_at timestamptz not null default now(),
  unique (key, user_id)
);
alter table sys_idempotency enable row level security;

create table sys_settings (
  key text primary key,
  value jsonb not null,
  description text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table sys_settings enable row level security;

insert into sys_settings (key, value, description)
values ('backdating_days', '3'::jsonb, 'Days a business date may precede today (H-24)');
