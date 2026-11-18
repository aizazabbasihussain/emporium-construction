-- P2-02 Stage billing, advances and credit notes. RLS is enabled with no policies (deny-all).
-- Projects, parties, users and tax authorities are opaque keys: no foreign keys to other modules.

-- BR-1: the billing schedule of a project. Stages sum to the current contract value before any
-- invoice can be issued.
create table bil_billing_schedule (
  id uuid primary key,
  project_id uuid not null,
  stage_no integer not null check (stage_no > 0),
  name text not null check (btrim(name) <> ''),
  basis_percent numeric(9,4),
  -- A variation stage can be negative (deductive variation).
  amount numeric(18,2) not null,
  source text not null check (source in ('quotation', 'variation', 'manual')),
  source_id uuid,
  status text not null default 'planned' check (status in ('planned', 'invoiced', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (project_id, stage_no)
);
alter table bil_billing_schedule enable row level security;
create unique index bil_schedule_variation_idx
  on bil_billing_schedule (project_id, source_id) where source = 'variation';

-- BR-1: a manual edit waits for approval; `previous` keeps the planned stages to restore on refusal.
create table bil_schedule_edits (
  id uuid primary key,
  project_id uuid not null,
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected')),
  previous jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  decided_at timestamptz
);
alter table bil_schedule_edits enable row level security;
create index bil_schedule_edits_project_idx on bil_schedule_edits (project_id);

create table bil_invoices (
  id uuid primary key,
  -- BR-5: allocated at issue, never at draft.
  number text,
  series_code text,
  authority_code text,
  source_type text not null check (source_type in ('project_stage', 'advance', 'variation')),
  project_id uuid not null,
  party_id uuid not null,
  invoice_date date not null,
  due_date date not null,
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'issued', 'cancelled')),
  base_amount numeric(18,2) not null default 0,
  advance_recovery numeric(18,2) not null default 0 check (advance_recovery >= 0),
  taxable_base numeric(18,2) not null default 0,
  tax_total numeric(18,2) not null default 0,
  gross_total numeric(18,2) not null default 0,
  withholding_expected numeric(18,2) not null default 0,
  tax_snapshot jsonb,
  registration_number text,
  -- BR-3: states whether advance tax was charged at receipt (the invoice then taxes the full base).
  tax_on_advance_at_receipt boolean not null default true,
  payment_days integer check (payment_days is null or payment_days >= 0),
  notes text,
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (status not in ('issued') or (number is not null and tax_snapshot is not null)),
  check (due_date >= invoice_date)
);
alter table bil_invoices enable row level security;
create unique index bil_invoices_number_idx on bil_invoices (number) where number is not null;
create index bil_invoices_project_idx on bil_invoices (project_id) where deleted_at is null;
create index bil_invoices_status_idx on bil_invoices (status) where deleted_at is null;

create table bil_invoice_lines (
  id uuid primary key,
  invoice_id uuid not null references bil_invoices (id),
  line_no integer not null check (line_no > 0),
  schedule_id uuid references bil_billing_schedule (id),
  description text not null check (btrim(description) <> ''),
  amount numeric(18,2) not null,
  supply_kind text not null check (supply_kind in ('goods', 'services')),
  nature text,
  unique (invoice_id, line_no)
);
alter table bil_invoice_lines enable row level security;

create table bil_advances (
  id uuid primary key,
  project_id uuid not null,
  party_id uuid not null,
  -- BR-8: the advance invoice that bills it.
  invoice_id uuid references bil_invoices (id),
  amount numeric(18,2) not null check (amount > 0),
  received_on date,
  applied numeric(18,2) not null default 0 check (applied >= 0),
  status text not null default 'requested'
    check (status in ('requested', 'received', 'fully_applied', 'refunded')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (applied <= amount),
  check (status = 'requested' or received_on is not null)
);
alter table bil_advances enable row level security;
create index bil_advances_project_idx on bil_advances (project_id);

create table bil_credit_notes (
  id uuid primary key,
  -- BR-9: numbered from the credit-note series when issued.
  number text,
  invoice_id uuid not null references bil_invoices (id),
  reason text not null check (btrim(reason) <> ''),
  base_amount numeric(18,2) not null check (base_amount > 0),
  -- The advance recovery of the invoice that this credit gives back to the advance.
  advance_restored numeric(18,2) not null default 0 check (advance_restored >= 0),
  tax_total numeric(18,2) not null default 0,
  gross_total numeric(18,2) not null default 0,
  issued_on date,
  tax_snapshot jsonb,
  status text not null default 'draft' check (status in ('draft', 'issued')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (status <> 'issued' or (number is not null and issued_on is not null))
);
alter table bil_credit_notes enable row level security;
create unique index bil_credit_notes_number_idx on bil_credit_notes (number) where number is not null;
create index bil_credit_notes_invoice_idx on bil_credit_notes (invoice_id);

-- Published read view for receivables (P2-04): what each issued invoice asks for, net of credit notes.
create view bil_v_invoices with (security_invoker = true) as
select i.id, i.number, i.series_code, i.authority_code, i.source_type, i.project_id, i.party_id,
       i.invoice_date, i.due_date, i.status, i.gross_total, i.withholding_expected,
       coalesce((select sum(c.gross_total) from bil_credit_notes c
                  where c.invoice_id = i.id and c.status = 'issued'), 0)::numeric(18,2) as credited_total
  from bil_invoices i
 where i.deleted_at is null;

-- The credit-note series (CN, gapless, BR-9) is created by the module on the first credit note, so
-- the kernel's seeded series stay as P1-01 defines them.

-- H-09: the owner approves invoices, credit notes and manual schedule changes.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:invoice')::uuid, 'invoice', 0, null, date '2026-01-01'),
       (md5('apr_rule:credit_note')::uuid, 'credit_note', 0, null, date '2026-01-01'),
       (md5('apr_rule:billing_schedule')::uuid, 'billing_schedule', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:invoice')::uuid, 1, 'management', 1),
       (md5('apr_rule:credit_note')::uuid, 1, 'management', 1),
       (md5('apr_rule:billing_schedule')::uuid, 1, 'management', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'billing.schedule.read'), ('accountant', 'billing.schedule.read'),
    ('management', 'billing.schedule.read'),
    ('admin', 'billing.schedule.manage'), ('accountant', 'billing.schedule.manage'),
    ('admin', 'billing.invoice.read'), ('accountant', 'billing.invoice.read'),
    ('management', 'billing.invoice.read'),
    ('admin', 'billing.invoice.create'), ('accountant', 'billing.invoice.create'),
    ('admin', 'billing.invoice.issue'), ('accountant', 'billing.invoice.issue'),
    ('admin', 'billing.creditnote.create'), ('accountant', 'billing.creditnote.create'),
    ('admin', 'billing.advance.manage'), ('accountant', 'billing.advance.manage')
  ) as t (role_code, permission_code);
