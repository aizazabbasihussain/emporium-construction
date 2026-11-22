-- P2-09 Accountant exports and account tags. The module keeps the chart of accounts, posting
-- suggestions, the tag of each financial document line and a log of export runs. It holds no balance,
-- journal or statement (constitution 14). RLS is enabled with no policies (deny-all); documents and
-- users are opaque keys.

create table acc_accounts (
  code text primary key check (code ~ '^[0-9A-Za-z.-]{1,20}$'),
  name text not null,
  type text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_code text references acc_accounts (code),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1
);
alter table acc_accounts enable row level security;

-- The chart of accounts accepted provisionally for H-05 (docs/decisions/chart-of-accounts-draft.md).
insert into acc_accounts (code, name, type, parent_code) values
  ('1000', 'Assets', 'asset', null),
  ('1100', 'Cash and bank', 'asset', '1000'),
  ('1110', 'Cash in hand', 'asset', '1100'),
  ('1120', 'Petty cash and site imprest', 'asset', '1100'),
  ('1130', 'Bank account (one line per bank)', 'asset', '1100'),
  ('1140', 'Post-dated cheques received', 'asset', '1100'),
  ('1200', 'Receivables', 'asset', '1000'),
  ('1210', 'Trade receivables (clients)', 'asset', '1200'),
  ('1220', 'Retention receivable', 'asset', '1200'),
  ('1230', 'Unbilled work in progress', 'asset', '1200'),
  ('1300', 'Advances and deposits', 'asset', '1000'),
  ('1310', 'Advances to vendors', 'asset', '1300'),
  ('1320', 'Advances to subcontractors', 'asset', '1300'),
  ('1330', 'Staff and worker advances', 'asset', '1300'),
  ('1340', 'Security deposits paid', 'asset', '1300'),
  ('1400', 'Tax receivable', 'asset', '1000'),
  ('1410', 'Input sales tax', 'asset', '1400'),
  ('1420', 'Income tax withheld by clients (adjustable)', 'asset', '1400'),
  ('1500', 'Inventory (company-owned stock)', 'asset', '1000'),
  ('1600', 'Fixed assets', 'asset', '1000'),
  ('1610', 'Equipment and tools', 'asset', '1600'),
  ('1620', 'Vehicles', 'asset', '1600'),
  ('1690', 'Accumulated depreciation', 'asset', '1600'),
  ('2000', 'Liabilities', 'liability', null),
  ('2100', 'Payables', 'liability', '2000'),
  ('2110', 'Trade payables (vendors)', 'liability', '2100'),
  ('2120', 'Subcontractor payables', 'liability', '2100'),
  ('2130', 'Retention payable', 'liability', '2100'),
  ('2140', 'Accrued expenses', 'liability', '2100'),
  ('2200', 'Payroll liabilities', 'liability', '2000'),
  ('2210', 'Wages payable', 'liability', '2200'),
  ('2220', 'Advances recoverable from wages', 'liability', '2200'),
  ('2300', 'Taxes payable', 'liability', '2000'),
  ('2310', 'Output sales tax (FBR)', 'liability', '2300'),
  ('2320', 'Output sales tax (PRA, when registered)', 'liability', '2300'),
  ('2330', 'Tax withheld from vendors, payable', 'liability', '2300'),
  ('2400', 'Client advances and deposits received', 'liability', '2000'),
  ('2500', 'Loans and borrowings', 'liability', '2000'),
  ('3000', 'Equity', 'equity', null),
  ('3100', 'Owner capital', 'equity', '3000'),
  ('3200', 'Owner drawings', 'equity', '3000'),
  ('3300', 'Retained earnings', 'equity', '3000'),
  ('4000', 'Income', 'income', null),
  ('4100', 'Contract revenue, construction', 'income', '4000'),
  ('4110', 'Contract revenue, demolition and restructuring', 'income', '4000'),
  ('4120', 'Variation revenue', 'income', '4000'),
  ('4200', 'Maintenance and service revenue', 'income', '4000'),
  ('4900', 'Other income', 'income', '4000'),
  ('5000', 'Direct project costs', 'expense', null),
  ('5100', 'Materials', 'expense', '5000'),
  ('5200', 'Direct labour', 'expense', '5000'),
  ('5300', 'Subcontractors', 'expense', '5000'),
  ('5400', 'Equipment and tools hire', 'expense', '5000'),
  ('5500', 'Site expenses', 'expense', '5000'),
  ('5600', 'Other direct costs', 'expense', '5000'),
  ('5900', 'Stock adjustments and wastage', 'expense', '5000'),
  ('6000', 'Overheads', 'expense', null),
  ('6100', 'Office salaries', 'expense', '6000'),
  ('6200', 'Rent and utilities', 'expense', '6000'),
  ('6300', 'Vehicle and fuel', 'expense', '6000'),
  ('6400', 'Professional fees', 'expense', '6000'),
  ('6500', 'Bank charges', 'expense', '6000'),
  ('6600', 'Depreciation', 'expense', '6000'),
  ('6900', 'Other overheads', 'expense', '6000');

-- Posting suggestions per document type. `condition` is a flat object of attribute values the document
-- must have; the more attributes a rule names, the more specific it is.
create table acc_mapping_rules (
  id uuid primary key,
  source_doc_type text not null check (source_doc_type in (
    'invoice', 'credit_note', 'bill', 'vendor_payment', 'receipt', 'cash_transaction',
    'payroll_run', 'stock_movement', 'expense_claim')),
  condition jsonb not null default '{}'::jsonb check (jsonb_typeof(condition) = 'object'),
  debit_account_code text not null references acc_accounts (code),
  credit_account_code text not null references acc_accounts (code),
  effective_from date not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table acc_mapping_rules enable row level security;
create index acc_mapping_rules_type_idx on acc_mapping_rules (source_doc_type, effective_from desc);

-- The tag of one document line. A tag stays as it is when the rules change (BR-1).
create table acc_tags (
  source_doc_type text not null,
  source_doc_id text not null,
  line_ref text not null default '',
  account_code text not null references acc_accounts (code),
  tagged_by uuid,
  method text not null check (method in ('rule', 'manual')),
  tagged_at timestamptz not null,
  primary key (source_doc_type, source_doc_id, line_ref)
);
alter table acc_tags enable row level security;
create index acc_tags_account_idx on acc_tags (account_code);

-- One row per export run. Never updated or deleted (constitution 5.11).
create table acc_export_runs (
  id uuid primary key,
  export_code text not null,
  schema_version integer not null check (schema_version >= 1),
  filters jsonb not null default '{}'::jsonb,
  row_count integer not null check (row_count >= 0),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  file_id uuid,
  run_by uuid,
  run_at timestamptz not null
);
alter table acc_export_runs enable row level security;
create index acc_export_runs_code_idx on acc_export_runs (export_code, run_at desc);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('accountant', 'accounting.export.run'), ('management', 'accounting.export.run'),
    ('admin', 'accounting.export.run'),
    ('accountant', 'accounting.export.read'), ('management', 'accounting.export.read'),
    ('admin', 'accounting.export.read'),
    ('accountant', 'accounting.tag.manage'), ('admin', 'accounting.tag.manage'),
    ('accountant', 'accounting.rules.manage'), ('admin', 'accounting.rules.manage')
  ) as t (role_code, permission_code);
