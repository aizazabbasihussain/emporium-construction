-- P2-04 Receivables, receipts and PDC register. RLS is enabled with no policies (deny-all).
-- Parties, invoices, advances, accounts and users are opaque keys: no foreign keys to other modules.

create table rcv_receipts (
  id uuid primary key,
  number text not null,
  party_id uuid not null,
  receipt_date date not null,
  method text not null check (method in ('cash', 'cheque', 'bank_transfer', 'online', 'pdc')),
  amount numeric(18,2) not null check (amount > 0),
  -- Known at once for cash, transfer and online; chosen at deposit for cheques and PDCs.
  account_id uuid,
  reference text,
  status text not null check (status in ('recorded', 'pending_clearing', 'cleared', 'bounced', 'cancelled')),
  withheld_amount numeric(18,2) not null default 0 check (withheld_amount >= 0),
  withholding_certificate_ref text,
  -- The cash book entry that moved the money (BR-2) and the one that reversed it (BR-9).
  cashbook_txn_id uuid,
  reversal_txn_id uuid,
  -- Balances count a receipt from `cleared_on` until `cancelled_on` (BR-8: as of any date).
  cleared_on date,
  cancelled_on date,
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (number),
  check (status <> 'cancelled' or (cancelled_on is not null and btrim(coalesce(cancel_reason, '')) <> '')),
  check (status <> 'cleared' or cleared_on is not null)
);
alter table rcv_receipts enable row level security;
create index rcv_receipts_party_idx on rcv_receipts (party_id, receipt_date);

-- BR-9: allocations are never changed; a receipt that stops counting (bounced, cancelled) takes
-- its allocations out of every balance through its own status.
create table rcv_allocations (
  id uuid primary key,
  receipt_id uuid not null references rcv_receipts (id),
  invoice_id uuid not null,
  advance_id uuid,
  amount numeric(18,2) not null check (amount > 0),
  kind text not null check (kind in ('invoice', 'advance', 'withholding')),
  created_at timestamptz not null default now(),
  created_by uuid,
  check (kind <> 'advance' or advance_id is not null)
);
alter table rcv_allocations enable row level security;
create index rcv_allocations_receipt_idx on rcv_allocations (receipt_id);
create index rcv_allocations_invoice_idx on rcv_allocations (invoice_id);

create function rcv_allocations_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'rcv_allocations is immutable' using errcode = 'restrict_violation';
end;
$$;
create trigger rcv_allocations_no_change before update or delete on rcv_allocations
  for each row execute function rcv_allocations_immutable();
create trigger rcv_allocations_no_truncate before truncate on rcv_allocations
  for each statement execute function rcv_allocations_immutable();

create table rcv_pdcs (
  id uuid primary key,
  receipt_id uuid not null references rcv_receipts (id),
  cheque_number text not null check (btrim(cheque_number) <> ''),
  bank_name text not null check (btrim(bank_name) <> ''),
  drawer text,
  cheque_date date not null,
  amount numeric(18,2) not null check (amount > 0),
  status text not null default 'received'
    check (status in ('received', 'deposited', 'cleared', 'bounced', 'returned', 'replaced')),
  deposit_account_id uuid,
  deposited_on date,
  early_deposit_reason text,
  cleared_on date,
  bounced_on date,
  bounce_reason text,
  replaced_by_pdc_id uuid references rcv_pdcs (id),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (receipt_id),
  check (status <> 'replaced' or replaced_by_pdc_id is not null),
  check (status <> 'bounced' or (bounced_on is not null and btrim(coalesce(bounce_reason, '')) <> ''))
);
alter table rcv_pdcs enable row level security;
create index rcv_pdcs_status_idx on rcv_pdcs (status, cheque_date);

-- BR-11: an approved small-balance write-off; never changed afterwards.
create table rcv_adjustments (
  id uuid primary key,
  party_id uuid not null,
  invoice_id uuid not null,
  adjustment_date date not null,
  amount numeric(18,2) not null check (amount > 0),
  reason text not null check (btrim(reason) <> ''),
  approval_doc_id uuid not null,
  approved_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (approval_doc_id)
);
alter table rcv_adjustments enable row level security;
create index rcv_adjustments_invoice_idx on rcv_adjustments (invoice_id);
create trigger rcv_adjustments_no_change before update or delete on rcv_adjustments
  for each row execute function rcv_allocations_immutable();
create trigger rcv_adjustments_no_truncate before truncate on rcv_adjustments
  for each statement execute function rcv_allocations_immutable();

create table rcv_followups (
  id uuid primary key,
  party_id uuid not null,
  invoice_id uuid,
  pdc_id uuid references rcv_pdcs (id),
  due_date date not null,
  note text not null check (btrim(note) <> ''),
  status text not null default 'open' check (status in ('open', 'done')),
  assigned_to uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table rcv_followups enable row level security;
create index rcv_followups_open_idx on rcv_followups (due_date) where status = 'open';

-- BR-7: the daily reminder runs once per business day.
create table rcv_reminder_runs (
  run_date date primary key,
  due_count integer not null,
  ran_at timestamptz not null default now()
);
alter table rcv_reminder_runs enable row level security;

-- Published read view (constitution 3.3): every allocation with the state of its receipt, so
-- other modules can total what was collected without reading rcv_ tables.
create view rcv_v_customer_ledger with (security_invoker = true) as
select a.id as allocation_id, r.id as receipt_id, r.number as receipt_number, r.party_id,
       r.receipt_date, r.status as receipt_status, r.cleared_on, r.cancelled_on,
       a.invoice_id, a.advance_id, a.kind, a.amount
  from rcv_allocations a
  join rcv_receipts r on r.id = a.receipt_id;

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'receivables.receipt.create'), ('accountant', 'receivables.receipt.create'),
    ('admin', 'receivables.receipt.cancel'), ('accountant', 'receivables.receipt.cancel'),
    ('admin', 'receivables.pdc.manage'), ('accountant', 'receivables.pdc.manage'),
    ('admin', 'receivables.ledger.read'), ('accountant', 'receivables.ledger.read'),
    ('management', 'receivables.ledger.read'),
    ('admin', 'receivables.adjustment.create'), ('accountant', 'receivables.adjustment.create')
  ) as t (role_code, permission_code);
