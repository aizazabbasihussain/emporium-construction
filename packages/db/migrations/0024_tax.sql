-- P2-01 Tax engine: effective-dated sales tax and withholding rules by authority.
-- RLS is enabled with no policies (deny-all). The system ships with NO rates and NO rules (BR-9):
-- the only seeded rows are the two authorities and the two settings, none of which is a rate.

create table tax_authorities (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null,
  registration_type text not null check (registration_type in ('ntn', 'strn', 'pra', 'other'))
);
alter table tax_authorities enable row level security;
insert into tax_authorities (code, name, registration_type) values
  ('FBR', 'Federal Board of Revenue', 'strn'),
  ('PRA', 'Punjab Revenue Authority', 'pra');

-- Which authority taxes a supply in a region. Rows start as pending_approval (BR-6).
create table tax_region_map (
  id uuid primary key,
  region text not null check (region in ('islamabad', 'punjab')),
  supply_kind text not null check (supply_kind in ('goods', 'services')),
  authority_code text not null references tax_authorities (code),
  effective_from date not null,
  effective_to date,
  note text,
  status text not null check (status in ('pending_approval', 'active', 'rejected')),
  requested_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
alter table tax_region_map enable row level security;
create index tax_region_map_key_idx on tax_region_map (region, supply_kind, effective_from);

create table tax_rules (
  id uuid primary key,
  authority_code text not null references tax_authorities (code),
  supply_kind text not null check (supply_kind in ('goods', 'services')),
  nature text check (nature is null or nature <> ''),
  rate_percent numeric(9,4) not null check (rate_percent >= 0 and rate_percent <= 100),
  tax_code text not null check (tax_code <> ''),
  effective_from date not null,
  effective_to date,
  note text,
  status text not null check (status in ('pending_approval', 'active', 'rejected')),
  requested_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
alter table tax_rules enable row level security;
create index tax_rules_key_idx on tax_rules (authority_code, supply_kind, effective_from);

create table tax_withholding_rules (
  id uuid primary key,
  direction text not null check (direction in ('client_withholds', 'we_withhold')),
  authority_code text not null references tax_authorities (code),
  party_type text check (party_type is null or party_type <> ''),
  nature text not null check (nature <> ''),
  rate_percent numeric(9,4) not null check (rate_percent >= 0 and rate_percent <= 100),
  base text not null check (base in ('on_invoice_total', 'on_tax_amount', 'on_base')),
  effective_from date not null,
  effective_to date,
  note text,
  status text not null check (status in ('pending_approval', 'active', 'rejected')),
  requested_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
alter table tax_withholding_rules enable row level security;
create index tax_withholding_rules_key_idx
  on tax_withholding_rules (direction, authority_code, nature, effective_from);

-- H-08 default: round per document; H-02: prices are entered without tax.
create table tax_settings (
  key text primary key,
  value text not null
);
alter table tax_settings enable row level security;
insert into tax_settings (key, value) values
  ('rounding_mode', 'per_document'),
  ('prices_include_tax', 'false');

-- BR-5: a rule is never edited in place and never deleted. Only its end date (when a successor
-- closes it) and its approval status may change, and neither can change twice.
create function tax_rule_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% rows are never deleted', tg_table_name;
  end if;
  if (to_jsonb(new) - 'effective_to' - 'status' - 'approved_by')
     <> (to_jsonb(old) - 'effective_to' - 'status' - 'approved_by') then
    raise exception '% rows are never edited in place; request a successor rule', tg_table_name;
  end if;
  if old.status <> 'pending_approval' and new.status <> old.status then
    raise exception '% status is final once decided', tg_table_name;
  end if;
  if old.effective_to is not null and new.effective_to is distinct from old.effective_to then
    raise exception '% end date is final once set', tg_table_name;
  end if;
  return new;
end;
$$;
create function tax_rule_no_truncate() returns trigger language plpgsql as $$
begin
  raise exception '% rows are never deleted', tg_table_name;
end;
$$;
create trigger tax_region_map_guard before update or delete on tax_region_map
  for each row execute function tax_rule_guard();
create trigger tax_rules_guard before update or delete on tax_rules
  for each row execute function tax_rule_guard();
create trigger tax_withholding_rules_guard before update or delete on tax_withholding_rules
  for each row execute function tax_rule_guard();
create trigger tax_region_map_no_truncate before truncate on tax_region_map
  execute function tax_rule_no_truncate();
create trigger tax_rules_no_truncate before truncate on tax_rules
  execute function tax_rule_no_truncate();
create trigger tax_withholding_rules_no_truncate before truncate on tax_withholding_rules
  execute function tax_rule_no_truncate();

-- BR-6 / H-09: the owner (management role) approves every rule change.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
values (md5('apr_rule:tax_rule')::uuid, 'tax_rule', 0, null, date '2026-01-01');
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
values (md5('apr_rule:tax_rule')::uuid, 1, 'management', 1);

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'tax.rule.read'), ('accountant', 'tax.rule.read'), ('management', 'tax.rule.read'),
    ('accountant', 'tax.rule.manage'),
    ('admin', 'tax.report.read'), ('accountant', 'tax.report.read'), ('management', 'tax.report.read')
  ) as t (role_code, permission_code);
