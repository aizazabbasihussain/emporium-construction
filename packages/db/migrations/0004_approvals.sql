-- P1-03 Approval engine: amount-band rules, routed requests and an append-only action history.
-- RLS is enabled with no policies (deny-all).

create table apr_rules (
  id uuid primary key,
  doc_type text not null check (doc_type ~ '^[a-z][a-z0-9_]*$'),
  min_amount numeric(18,2) not null check (min_amount >= 0),
  max_amount numeric(18,2) check (max_amount is null or max_amount > min_amount),
  effective_from date not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table apr_rules enable row level security;
create index apr_rules_lookup_idx on apr_rules (doc_type, effective_from) where active;

create table apr_rule_steps (
  rule_id uuid not null references apr_rules (id),
  step_no integer not null check (step_no >= 1),
  role_code text not null check (role_code <> ''),
  min_approvers integer not null default 1 check (min_approvers >= 1),
  primary key (rule_id, step_no)
);
alter table apr_rule_steps enable row level security;

create table apr_requests (
  id uuid primary key,
  doc_type text not null check (doc_type ~ '^[a-z][a-z0-9_]*$'),
  doc_id uuid not null,
  revision integer not null default 1 check (revision >= 1),
  amount numeric(18,2) not null check (amount >= 0),
  requester_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
  current_step integer not null check (current_step >= 1),
  rule_id uuid not null references apr_rules (id),
  context jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz,
  unique (doc_type, doc_id, revision)
);
alter table apr_requests enable row level security;
-- BR-6: only one open request per document.
create unique index apr_requests_one_open_uq on apr_requests (doc_type, doc_id) where status = 'pending';
create index apr_requests_inbox_idx on apr_requests (status, current_step, submitted_at);

create table apr_actions (
  id uuid primary key,
  request_id uuid not null references apr_requests (id),
  step_no integer not null check (step_no >= 1),
  actor_id uuid not null,
  action text not null check (action in ('approve', 'reject', 'return')),
  comment text,
  at timestamptz not null
);
alter table apr_actions enable row level security;
create index apr_actions_request_idx on apr_actions (request_id, at);

create function apr_actions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'apr_actions is append-only';
end;
$$;
create trigger apr_actions_no_update before update or delete on apr_actions
  for each row execute function apr_actions_immutable();
create trigger apr_actions_no_truncate before truncate on apr_actions
  execute function apr_actions_immutable();

-- H-09: the owner (management role) approves every approval item; no amount limits.
-- Other modules add their own document types through the rules editor.
insert into apr_rules (id, doc_type, min_amount, max_amount, effective_from)
select md5('apr_rule:' || doc_type)::uuid, doc_type, 0, null, date '2026-01-01'
  from (values ('requisition'), ('purchase_order'), ('expense'), ('payment'),
               ('quotation'), ('variation'), ('write_off')) as t (doc_type);
insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers)
select md5('apr_rule:' || doc_type)::uuid, 1, 'management', 1
  from (values ('requisition'), ('purchase_order'), ('expense'), ('payment'),
               ('quotation'), ('variation'), ('write_off')) as t (doc_type);

insert into sys_role_permissions (role_code, permission_code) values
  ('admin', 'approvals.inbox.read'),
  ('management', 'approvals.inbox.read'),
  ('project_manager', 'approvals.inbox.read'),
  ('procurement', 'approvals.inbox.read'),
  ('accountant', 'approvals.inbox.read'),
  ('admin', 'approvals.rule.manage'),
  ('management', 'approvals.rule.manage'),
  ('admin', 'approvals.request.read'),
  ('management', 'approvals.request.read'),
  ('project_manager', 'approvals.request.read'),
  ('procurement', 'approvals.request.read'),
  ('accountant', 'approvals.request.read'),
  ('storekeeper', 'approvals.request.read'),
  ('supervisor', 'approvals.request.read'),
  ('service_coordinator', 'approvals.request.read'),
  ('estimator', 'approvals.request.read');
