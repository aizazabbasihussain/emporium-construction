-- P2-03 Cash and bank book. RLS is enabled with no policies (deny-all).
-- Parties, users and source documents are opaque keys: no foreign keys to other modules.

create table cbk_accounts (
  id uuid primary key,
  code text not null check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  kind text not null check (kind in ('cash', 'bank', 'petty_cash', 'wallet')),
  bank_name text,
  -- Only a masked form is stored (for example ****1234), never a full account number.
  account_number_masked text,
  -- P2-09 and BR-7: the chart-of-accounts code every transaction of the account carries by default.
  account_code_tag text,
  -- BR-1: set once from the opening data (H-13), then immutable.
  opening_balance numeric(18,2) not null default 0,
  opening_date date not null,
  -- BR-3: a bank account or wallet may go below zero only when this is true.
  allow_overdraft boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table cbk_accounts enable row level security;
create unique index cbk_accounts_code_idx on cbk_accounts (lower(code)) where deleted_at is null;

create function cbk_accounts_opening_immutable() returns trigger language plpgsql as $$
begin
  if new.opening_balance is distinct from old.opening_balance
     or new.opening_date is distinct from old.opening_date
     or new.kind is distinct from old.kind then
    raise exception 'the opening balance, opening date and kind of a cash account are immutable'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger cbk_accounts_opening_lock before update on cbk_accounts
  for each row execute function cbk_accounts_opening_immutable();

create table cbk_reconciliations (
  id uuid primary key,
  account_id uuid not null references cbk_accounts (id),
  statement_from date not null,
  statement_to date not null,
  statement_closing_balance numeric(18,2) not null,
  book_balance_at_end numeric(18,2),
  difference numeric(18,2),
  status text not null default 'draft' check (status in ('draft', 'completed')),
  completed_by uuid,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (statement_to >= statement_from),
  check (status <> 'completed' or (completed_by is not null and difference = 0))
);
alter table cbk_reconciliations enable row level security;
create index cbk_reconciliations_account_idx on cbk_reconciliations (account_id);

-- BR-2: a transaction is never changed or deleted. Only two classifications move after posting:
-- the reconciled flag (BR-8) and the account tag (BR-7).
create table cbk_transactions (
  id uuid primary key,
  number text not null,
  account_id uuid not null references cbk_accounts (id),
  txn_date date not null,
  direction text not null check (direction in ('in', 'out')),
  amount numeric(18,2) not null check (amount > 0),
  txn_type text not null check (txn_type in
    ('receipt', 'payment', 'transfer_in', 'transfer_out', 'bank_charge', 'advance', 'other')),
  counterparty_party_id uuid,
  source_module text,
  source_doc_type text,
  source_doc_id uuid,
  method text not null check (method in ('cash', 'cheque', 'bank_transfer', 'online', 'wallet')),
  reference text,
  description text,
  account_tag text,
  reconciled_in uuid references cbk_reconciliations (id),
  reverses_id uuid references cbk_transactions (id),
  reversal_reason text,
  -- BR-4: both legs of a transfer carry the same pair id.
  transfer_pair_id uuid,
  -- BR-5: the approved payment request that allowed the payment.
  approval_doc_id uuid,
  idempotency_key text not null,
  posted_at timestamptz not null default now(),
  posted_by uuid,
  unique (number),
  unique (idempotency_key),
  unique (reverses_id),
  check (reverses_id is null or btrim(coalesce(reversal_reason, '')) <> ''),
  -- The direction follows the type, except for a reversal (which runs the other way) and `other`.
  check (
    reverses_id is not null or txn_type = 'other'
    or (txn_type in ('receipt', 'transfer_in') and direction = 'in')
    or (txn_type in ('payment', 'transfer_out', 'bank_charge', 'advance') and direction = 'out')
  )
);
alter table cbk_transactions enable row level security;
create index cbk_transactions_account_idx on cbk_transactions (account_id, txn_date);
create index cbk_transactions_source_idx on cbk_transactions (source_doc_type, source_doc_id);
create index cbk_transactions_untagged_idx on cbk_transactions (txn_date) where account_tag is null;

create function cbk_transactions_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'reconciled_in' - 'account_tag')
         is not distinct from (to_jsonb(old) - 'reconciled_in' - 'account_tag') then
    return new;
  end if;
  raise exception 'cbk_transactions is append-only' using errcode = 'restrict_violation';
end;
$$;
create trigger cbk_transactions_no_change before update or delete on cbk_transactions
  for each row execute function cbk_transactions_append_only();
create trigger cbk_transactions_no_truncate before truncate on cbk_transactions
  for each statement execute function cbk_transactions_append_only();

create table cbk_statement_lines (
  id uuid primary key,
  reconciliation_id uuid not null references cbk_reconciliations (id),
  line_no integer not null check (line_no > 0),
  line_date date not null,
  description text not null default '',
  debit numeric(18,2) not null default 0 check (debit >= 0),
  credit numeric(18,2) not null default 0 check (credit >= 0),
  matched_transaction_id uuid references cbk_transactions (id),
  unique (reconciliation_id, line_no),
  check ((debit > 0) <> (credit > 0))
);
alter table cbk_statement_lines enable row level security;

create table cbk_reconciliation_items (
  reconciliation_id uuid not null references cbk_reconciliations (id),
  transaction_id uuid not null references cbk_transactions (id),
  matched_statement_ref text,
  primary key (reconciliation_id, transaction_id),
  -- A transaction waits in at most one reconciliation at a time.
  unique (transaction_id)
);
alter table cbk_reconciliation_items enable row level security;

-- BR-6: money movements announced by other modules wait here until a cash account is chosen
-- (or the configured advance account takes them automatically).
create table cbk_pending_sources (
  id uuid primary key,
  source_module text not null,
  source_doc_type text not null,
  source_doc_id uuid not null,
  direction text not null check (direction in ('in', 'out')),
  amount numeric(18,2) not null check (amount > 0),
  txn_date date not null,
  description text,
  counterparty_user_id uuid,
  status text not null default 'pending' check (status in ('pending', 'recorded')),
  note text,
  transaction_id uuid references cbk_transactions (id),
  created_at timestamptz not null default now(),
  unique (source_doc_type, source_doc_id)
);
alter table cbk_pending_sources enable row level security;

-- Transaction numbers are gapless: a number is taken inside the posting transaction.
insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('cash_txn', 'CB', 5, true, true, 1, 1);

-- Published read view (constitution 3.3): money movements with their sign and reversal state.
create view cbk_v_transactions with (security_invoker = true) as
select t.id, t.number, t.account_id, t.txn_date, t.direction, t.amount,
       (case when t.direction = 'in' then t.amount else -t.amount end)::numeric(18,2) as signed_amount,
       t.txn_type, t.counterparty_party_id, t.source_module, t.source_doc_type, t.source_doc_id,
       t.method, t.reference, t.description, t.account_tag, t.reconciled_in, t.reverses_id,
       exists (select 1 from cbk_transactions r where r.reverses_id = t.id) as reversed
  from cbk_transactions t;

-- H-09: the owner approves a cash adjustment, like every other approval item (BR-1).
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:cash_adjustment')::uuid, 'cash_adjustment', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:cash_adjustment')::uuid, 1, 'management', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'cashbook.account.manage'), ('accountant', 'cashbook.account.manage'),
    ('management', 'cashbook.account.manage'),
    ('admin', 'cashbook.txn.read'), ('accountant', 'cashbook.txn.read'),
    ('management', 'cashbook.txn.read'),
    ('admin', 'cashbook.txn.create'), ('accountant', 'cashbook.txn.create'),
    ('admin', 'cashbook.txn.reverse'), ('accountant', 'cashbook.txn.reverse'),
    ('admin', 'cashbook.reconciliation.manage'), ('accountant', 'cashbook.reconciliation.manage')
  ) as t (role_code, permission_code);
