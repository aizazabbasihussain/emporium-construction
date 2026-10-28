-- P1-14 Site expenses and petty cash. RLS is enabled with no policies (deny-all). Users, projects,
-- cost codes and files are opaque keys: no foreign keys to other modules.

create table exp_custodians (
  user_id uuid primary key,
  -- Reported next to the balance; it does not block an advance.
  float_limit numeric(18,2) not null default 0 check (float_limit >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
alter table exp_custodians enable row level security;

create table exp_categories (
  code text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (btrim(name) <> ''),
  default_cost_code_id uuid,
  receipt_required boolean not null default false,
  max_without_receipt numeric(18,2) not null default 0 check (max_without_receipt >= 0),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
alter table exp_categories enable row level security;

create table exp_advances (
  id uuid primary key,
  number text not null unique,
  custodian_id uuid not null references exp_custodians (user_id),
  amount numeric(18,2) not null check (amount > 0),
  issued_on date not null,
  issued_by uuid not null,
  purpose text not null check (btrim(purpose) <> ''),
  status text not null default 'issued' check (status in ('issued', 'settled', 'cancelled')),
  -- BR-8: set when the advance is settled, with the accountant's note for a manual settlement.
  settled_on date,
  settlement_note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table exp_advances enable row level security;
create index exp_advances_custodian_idx on exp_advances (custodian_id) where deleted_at is null;

create table exp_claims (
  id uuid primary key,
  number text not null unique,
  claimant_id uuid not null,
  submitted_on date,
  status text not null default 'draft' check (status in
    ('draft', 'submitted', 'approved', 'rejected', 'returned', 'posted', 'cancelled')),
  total numeric(18,2) not null default 0 check (total >= 0),
  note text not null default '',
  -- BR-7: why an approved or posted claim was cancelled or reversed.
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table exp_claims enable row level security;
create index exp_claims_claimant_idx on exp_claims (claimant_id) where deleted_at is null;
create index exp_claims_status_idx on exp_claims (status) where deleted_at is null;

create table exp_claim_lines (
  id uuid primary key,
  claim_id uuid not null references exp_claims (id),
  line_no integer not null check (line_no > 0),
  expense_date date not null,
  category text not null references exp_categories (code),
  description text not null check (btrim(description) <> ''),
  cost_object_type text not null check (cost_object_type in ('project', 'overhead')),
  cost_object_id uuid,
  cost_code_id uuid not null,
  amount numeric(18,2) not null check (amount > 0),
  receipt_file_id uuid,
  -- BR-5: the latest entry of the line's chain in the cost ledger; null before approval.
  cost_entry_id uuid,
  unique (claim_id, line_no),
  check ((cost_object_type = 'project' and cost_object_id is not null)
      or (cost_object_type = 'overhead' and cost_object_id is null))
);
alter table exp_claim_lines enable row level security;
create index exp_claim_lines_duplicate_idx on exp_claim_lines (expense_date, amount, category);

insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values ('expense_claim', 'EXP', 4, true, false, 1, 1),
       ('expense_advance', 'ADV', 4, true, false, 1, 1);

-- BR-4 / H-09: the owner (management role) approves every expense claim.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:expense_claim')::uuid, 'expense_claim', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:expense_claim')::uuid, 1, 'management', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('supervisor', 'expenses.claim.create'), ('project_manager', 'expenses.claim.create'),
    ('storekeeper', 'expenses.claim.create'),
    -- The action part of a permission code allows letters, digits and underscores, so the spec's
    -- read-own and read-all are spelled read_own and read_all.
    ('supervisor', 'expenses.claim.read_own'), ('project_manager', 'expenses.claim.read_own'),
    ('storekeeper', 'expenses.claim.read_own'),
    ('accountant', 'expenses.claim.read_all'), ('management', 'expenses.claim.read_all'),
    ('accountant', 'expenses.claim.post'),
    ('accountant', 'expenses.claim.reverse'),
    ('accountant', 'expenses.advance.issue'),
    ('accountant', 'expenses.category.manage')
  ) as t (role_code, permission_code);
