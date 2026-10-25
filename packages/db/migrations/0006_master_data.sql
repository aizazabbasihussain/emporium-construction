-- P1-05 Master data and company profile: shared reference data for every module.
-- RLS is enabled with no policies (deny-all). Phone numbers are stored as E.164 (+92...), CNIC as 13 digits.

create table mst_company (
  id uuid primary key,
  name text not null check (name <> ''),
  address text,
  phone text,
  email text,
  logo_file_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table mst_company enable row level security;
-- The company profile is a single row.
create unique index mst_company_single_uq on mst_company ((true));

create table mst_tax_registrations (
  id uuid primary key,
  authority text not null check (authority ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  registration_type text not null check (registration_type in ('ntn', 'strn', 'pra', 'other')),
  number text not null check (number <> ''),
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (valid_to is null or valid_to >= valid_from)
);
alter table mst_tax_registrations enable row level security;
create index mst_tax_registrations_authority_idx
  on mst_tax_registrations (authority, registration_type) where deleted_at is null;

create table mst_parties (
  id uuid primary key,
  code text not null unique,
  name text not null check (btrim(name) <> ''),
  legal_name text,
  kind jsonb not null check (jsonb_typeof(kind) = 'array' and jsonb_array_length(kind) > 0),
  ntn text,
  strn text,
  cnic text check (cnic is null or cnic ~ '^[0-9]{13}$'),
  phone text check (phone is null or phone ~ '^\+92[1-9][0-9]{8,9}$'),
  email text,
  address text,
  city text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table mst_parties enable row level security;
-- BR-2: NTN and CNIC are unique among active parties.
create unique index mst_parties_ntn_uq on mst_parties (ntn)
  where ntn is not null and status = 'active' and deleted_at is null;
create unique index mst_parties_cnic_uq on mst_parties (cnic)
  where cnic is not null and status = 'active' and deleted_at is null;
create index mst_parties_name_idx
  on mst_parties ((lower(regexp_replace(btrim(name), '\s+', ' ', 'g')))) where deleted_at is null;
create index mst_parties_phone_idx on mst_parties (phone) where deleted_at is null;

create table mst_party_contacts (
  id uuid primary key,
  party_id uuid not null references mst_parties (id),
  name text not null check (btrim(name) <> ''),
  phone text check (phone is null or phone ~ '^\+92[1-9][0-9]{8,9}$'),
  email text,
  role text,
  created_at timestamptz not null default now()
);
alter table mst_party_contacts enable row level security;
create index mst_party_contacts_party_idx on mst_party_contacts (party_id);

create table mst_units (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{0,15}$'),
  name text not null check (btrim(name) <> ''),
  kind text not null check (kind in ('count', 'length', 'area', 'volume', 'weight', 'time', 'lump')),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table mst_units enable row level security;

create table mst_unit_conversions (
  id uuid primary key,
  from_unit text not null references mst_units (code),
  to_unit text not null references mst_units (code),
  factor numeric(18,6) not null check (factor > 0),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  check (from_unit <> to_unit),
  unique (from_unit, to_unit)
);
alter table mst_unit_conversions enable row level security;

create table mst_item_categories (
  id uuid primary key,
  code text not null unique,
  name text not null check (btrim(name) <> ''),
  parent_id uuid references mst_item_categories (id),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table mst_item_categories enable row level security;

create table mst_items (
  id uuid primary key,
  code text not null unique,
  name text not null check (btrim(name) <> ''),
  category_id uuid references mst_item_categories (id),
  unit_code text not null references mst_units (code),
  item_kind text not null check (item_kind in ('material', 'consumable', 'service', 'labour', 'equipment')),
  stockable boolean not null default false,
  default_tax_kind text not null check (default_tax_kind in ('goods', 'services')),
  reorder_level numeric(18,4) check (reorder_level is null or reorder_level >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  -- BR-4
  check (not stockable or item_kind in ('material', 'consumable'))
);
alter table mst_items enable row level security;
create index mst_items_category_idx on mst_items (category_id) where deleted_at is null;

create table mst_cost_codes (
  id uuid primary key,
  code text not null unique,
  name text not null check (btrim(name) <> ''),
  parent_id uuid references mst_cost_codes (id),
  kind text not null check (kind in ('material', 'labour', 'subcontract', 'equipment', 'overhead')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table mst_cost_codes enable row level security;

create table mst_locations (
  id uuid primary key,
  name text not null check (btrim(name) <> ''),
  region text not null check (region in ('islamabad', 'punjab')),
  city text not null check (btrim(city) <> ''),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table mst_locations enable row level security;

create table mst_vendor_prices (
  id uuid primary key,
  vendor_id uuid not null references mst_parties (id),
  item_id uuid not null references mst_items (id),
  unit_code text not null references mst_units (code),
  rate numeric(18,4) not null check (rate >= 0),
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  check (valid_to is null or valid_to >= valid_from)
);
alter table mst_vendor_prices enable row level security;
create index mst_vendor_prices_item_idx on mst_vendor_prices (item_id, vendor_id) where deleted_at is null;

-- BR-1: party codes come from one number series per kind (CL-0001, VN-0001, ...).
insert into sys_number_series (code, prefix, padding, reset_yearly, gapless, start_value, next_value)
values
  ('party_client', 'CL', 4, false, false, 1, 1),
  ('party_vendor', 'VN', 4, false, false, 1, 1),
  ('party_subcontractor', 'SC', 4, false, false, 1, 1),
  ('party_labour_contractor', 'LC', 4, false, false, 1, 1);

-- H-26 (default allowed): the standard construction units. No conversions are seeded.
insert into mst_units (code, name, kind) values
  ('nos', 'Numbers', 'count'), ('bag', 'Bag', 'count'), ('kg', 'Kilogram', 'weight'),
  ('ton', 'Ton', 'weight'), ('m', 'Metre', 'length'), ('ft', 'Foot', 'length'),
  ('sqft', 'Square foot', 'area'), ('sqm', 'Square metre', 'area'),
  ('cuft', 'Cubic foot', 'volume'), ('cum', 'Cubic metre', 'volume'),
  ('day', 'Day', 'time'), ('hour', 'Hour', 'time'), ('ls', 'Lump sum', 'lump');

-- H-25 (answered): the top-level cost codes. Sub-codes are added from the UI.
insert into mst_cost_codes (id, code, name, kind) values
  (gen_random_uuid(), '100', 'Materials', 'material'),
  (gen_random_uuid(), '200', 'Labour', 'labour'),
  (gen_random_uuid(), '300', 'Subcontractors', 'subcontract'),
  (gen_random_uuid(), '400', 'Equipment and tools', 'equipment'),
  (gen_random_uuid(), '500', 'Site expenses', 'overhead'),
  (gen_random_uuid(), '600', 'Other', 'overhead');

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'master.company.manage'),
    ('admin', 'master.reference.read'), ('management', 'master.reference.read'),
    ('project_manager', 'master.reference.read'), ('procurement', 'master.reference.read'),
    ('storekeeper', 'master.reference.read'), ('supervisor', 'master.reference.read'),
    ('accountant', 'master.reference.read'), ('service_coordinator', 'master.reference.read'),
    ('estimator', 'master.reference.read'),
    ('admin', 'master.party.read'), ('management', 'master.party.read'),
    ('project_manager', 'master.party.read'), ('procurement', 'master.party.read'),
    ('accountant', 'master.party.read'), ('service_coordinator', 'master.party.read'),
    ('estimator', 'master.party.read'),
    ('admin', 'master.party.manage'), ('management', 'master.party.manage'),
    ('project_manager', 'master.party.manage'), ('procurement', 'master.party.manage'),
    ('accountant', 'master.party.manage'),
    ('admin', 'master.item.read'), ('management', 'master.item.read'),
    ('project_manager', 'master.item.read'), ('procurement', 'master.item.read'),
    ('storekeeper', 'master.item.read'), ('supervisor', 'master.item.read'),
    ('accountant', 'master.item.read'), ('service_coordinator', 'master.item.read'),
    ('estimator', 'master.item.read'),
    ('admin', 'master.item.manage'), ('management', 'master.item.manage'),
    ('procurement', 'master.item.manage'),
    ('admin', 'master.costcode.manage'), ('management', 'master.costcode.manage'),
    ('accountant', 'master.costcode.manage'),
    ('admin', 'master.price.read'), ('management', 'master.price.read'),
    ('project_manager', 'master.price.read'), ('procurement', 'master.price.read'),
    ('accountant', 'master.price.read'), ('estimator', 'master.price.read'),
    ('admin', 'master.price.manage'), ('procurement', 'master.price.manage')
  ) as t (role_code, permission_code);
