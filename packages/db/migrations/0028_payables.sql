-- P2-05 Payables, vendor bills and payments. RLS is enabled with no policies (deny-all).
-- Vendors, purchase orders, goods receipts, cost entries, cost codes, accounts and users are opaque
-- keys: no foreign keys to other modules.

create table pay_bills (
  id uuid primary key,
  number text not null,
  vendor_party_id uuid not null,
  vendor_invoice_no text not null check (btrim(vendor_invoice_no) <> ''),
  bill_date date not null,
  due_date date not null,
  source_type text not null check (source_type in ('purchase', 'subcontract', 'expense_other', 'opening')),
  -- The document a registered provider (P2-06) built the bill from.
  source_doc_id uuid,
  status text not null default 'draft' check (status in
    ('draft', 'matched', 'pending_approval', 'approved', 'posted', 'partly_paid', 'paid', 'cancelled')),
  supply_kind text not null default 'goods' check (supply_kind in ('goods', 'services')),
  nature text not null default '',
  location_id uuid,
  base_amount numeric(18,2) not null default 0,
  tax_total numeric(18,2) not null default 0,
  gross_total numeric(18,2) not null default 0,
  withholding_total numeric(18,2) not null default 0 check (withholding_total >= 0),
  net_payable numeric(18,2) not null default 0,
  tax_snapshot jsonb,
  authority_code text,
  notes text,
  match_override_reason text,
  match_overridden_by uuid,
  posted_on date,
  posted_by uuid,
  cancelled_on date,
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (number),
  -- BR-2: one bill per vendor invoice number.
  unique (vendor_party_id, vendor_invoice_no),
  check (due_date >= bill_date),
  check (status <> 'cancelled' or (cancelled_on is not null and btrim(coalesce(cancel_reason, '')) <> ''))
);
alter table pay_bills enable row level security;
create index pay_bills_vendor_idx on pay_bills (vendor_party_id, status);
create index pay_bills_source_idx on pay_bills (source_type, source_doc_id);

create table pay_bill_lines (
  id uuid primary key,
  bill_id uuid not null references pay_bills (id),
  line_no integer not null check (line_no > 0),
  source_doc_type text,
  source_doc_id uuid,
  po_line_id uuid,
  grn_line_id uuid,
  description text not null default '',
  quantity numeric(18,4) not null check (quantity > 0),
  rate numeric(18,4) not null check (rate >= 0),
  amount numeric(18,2) not null,
  cost_object_type text not null check (cost_object_type in ('project', 'work_order', 'overhead')),
  cost_object_id uuid,
  cost_code_id uuid not null,
  -- The approved cost entry of the receipt or certificate this line confirms, and the posted entry that resulted.
  source_entry_id uuid,
  cost_entry_id uuid,
  unique (bill_id, line_no),
  check ((cost_object_type = 'overhead') = (cost_object_id is null))
);
alter table pay_bill_lines enable row level security;
create index pay_bill_lines_grn_idx on pay_bill_lines (grn_line_id) where grn_line_id is not null;

create table pay_matches (
  bill_line_id uuid primary key references pay_bill_lines (id),
  po_rate numeric(18,4) not null,
  grn_qty numeric(18,4) not null,
  billed_qty numeric(18,4) not null,
  billed_rate numeric(18,4) not null,
  qty_variance numeric(18,4) not null check (qty_variance >= 0),
  rate_variance numeric(18,4) not null,
  within_tolerance boolean not null
);
alter table pay_matches enable row level security;

create table pay_variances (
  id uuid primary key,
  bill_id uuid not null references pay_bills (id),
  bill_line_id uuid not null references pay_bill_lines (id),
  cost_object_type text not null check (cost_object_type in ('project', 'work_order', 'overhead')),
  cost_object_id uuid,
  amount numeric(18,2) not null,
  treatment text not null check (treatment in ('project_cost', 'overhead_cost')),
  ledger_entry_id uuid not null,
  reversed_on date,
  created_at timestamptz not null default now(),
  created_by uuid
);
alter table pay_variances enable row level security;
create index pay_variances_bill_idx on pay_variances (bill_id);

-- BR-11: one approval covers a batch of payments grouped by vendor.
create table pay_payment_runs (
  id uuid primary key,
  run_date date not null,
  total numeric(18,2) not null check (total >= 0),
  note text,
  created_at timestamptz not null default now(),
  created_by uuid
);
alter table pay_payment_runs enable row level security;

create table pay_payments (
  id uuid primary key,
  number text not null,
  vendor_party_id uuid not null,
  payment_date date not null,
  method text not null check (method in ('cash', 'cheque', 'bank_transfer', 'online')),
  amount numeric(18,2) not null check (amount >= 0),
  withholding_deducted numeric(18,2) not null default 0 check (withholding_deducted >= 0),
  account_id uuid not null,
  cheque_number text,
  cheque_date date,
  status text not null default 'draft' check (status in
    ('draft', 'pending_approval', 'approved', 'paid', 'cancelled')),
  -- The request that approved it (the approval document is this payment or, for a run, the run).
  approval_request_id uuid,
  approval_doc_id uuid,
  run_id uuid references pay_payment_runs (id),
  reference text,
  withholding_certificate_no text,
  paid_on date,
  paid_by uuid,
  cashbook_txn_id uuid,
  reversal_txn_id uuid,
  cancelled_on date,
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (number),
  check (method <> 'cheque' or (cheque_number is not null and btrim(cheque_number) <> '' and cheque_date is not null)),
  check (status <> 'cancelled' or (cancelled_on is not null and btrim(coalesce(cancel_reason, '')) <> '')),
  check (status <> 'paid' or paid_on is not null)
);
alter table pay_payments enable row level security;
create index pay_payments_vendor_idx on pay_payments (vendor_party_id, status);
create index pay_payments_run_idx on pay_payments (run_id) where run_id is not null;

-- Allocations are in gross terms: the cash paid plus the withholding deducted on that bill. They are
-- never changed; a payment that stops counting (cancelled) takes them out of every balance through
-- its own status.
create table pay_payment_allocations (
  id uuid primary key,
  payment_id uuid not null references pay_payments (id),
  bill_id uuid not null references pay_bills (id),
  amount numeric(18,2) not null check (amount > 0),
  withholding numeric(18,2) not null default 0 check (withholding >= 0),
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (payment_id, bill_id)
);
alter table pay_payment_allocations enable row level security;
create index pay_payment_allocations_bill_idx on pay_payment_allocations (bill_id);

create function pay_allocations_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'pay_payment_allocations is immutable' using errcode = 'restrict_violation';
end;
$$;
create trigger pay_payment_allocations_no_change before update or delete on pay_payment_allocations
  for each row execute function pay_allocations_immutable();
create trigger pay_payment_allocations_no_truncate before truncate on pay_payment_allocations
  for each statement execute function pay_allocations_immutable();

-- Published read view (constitution 3.3): every bill that is owed and every payment that counts, as
-- ledger lines of a vendor, so other modules read balances without reading pay_ tables.
create view pay_v_vendor_ledger with (security_invoker = true) as
select 'bill'::text as entry_type, b.id as document_id, b.number, b.vendor_party_id,
       b.bill_date as entry_date, b.source_type, b.source_doc_id,
       b.gross_total as credit, 0::numeric(18,2) as debit, b.withholding_total,
       b.net_payable, b.status
  from pay_bills b
 where b.status in ('posted', 'partly_paid', 'paid')
union all
select 'payment'::text, p.id, p.number, p.vendor_party_id, p.payment_date, null::text, null::uuid,
       0::numeric(18,2), p.amount + p.withholding_deducted, p.withholding_deducted,
       p.amount, p.status
  from pay_payments p
 where p.status = 'paid';

insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('vendor_bill', 'VB', 4, true, false, 1, 1);

-- BR-4, H-09: the owner approves every vendor bill; no amount limits.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:vendor_bill')::uuid, 'vendor_bill', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:vendor_bill')::uuid, 1, 'management', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'payables.bill.create'), ('accountant', 'payables.bill.create'),
    ('procurement', 'payables.bill.create'),
    ('admin', 'payables.bill.read'), ('accountant', 'payables.bill.read'),
    ('procurement', 'payables.bill.read'),
    ('admin', 'payables.bill.post'), ('accountant', 'payables.bill.post'),
    ('admin', 'payables.bill.override_match'), ('accountant', 'payables.bill.override_match'),
    ('admin', 'payables.payment.create'), ('accountant', 'payables.payment.create'),
    ('admin', 'payables.payment.pay'), ('accountant', 'payables.payment.pay'),
    ('admin', 'payables.ledger.read'), ('accountant', 'payables.ledger.read'),
    ('management', 'payables.ledger.read')
  ) as t (role_code, permission_code);
