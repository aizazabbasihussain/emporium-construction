-- P1-02 Identity: users, roles, role permissions, user roles and user scopes.
-- RLS is enabled with no policies (deny-all); the API uses a server-side role (constitution 3.6).
-- Passwords and sessions live in Supabase Auth; nothing secret is stored here.

create table sys_users (
  id uuid primary key,
  auth_subject text unique,
  email text not null unique check (email = lower(email) and email <> ''),
  full_name text not null check (full_name <> ''),
  phone text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  locale text not null default 'en' check (locale in ('en', 'ur')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table sys_users enable row level security;

create table sys_roles (
  code text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null check (name <> ''),
  description text not null default '',
  system boolean not null default false
);
alter table sys_roles enable row level security;

create table sys_role_permissions (
  role_code text not null references sys_roles (code),
  permission_code text not null check (permission_code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$'),
  primary key (role_code, permission_code)
);
alter table sys_role_permissions enable row level security;

create table sys_user_roles (
  user_id uuid not null references sys_users (id),
  role_code text not null references sys_roles (code),
  primary key (user_id, role_code)
);
create index sys_user_roles_role_idx on sys_user_roles (role_code);
alter table sys_user_roles enable row level security;

create table sys_user_scopes (
  user_id uuid not null references sys_users (id),
  scope_type text not null check (scope_type in ('project', 'team')),
  scope_id uuid not null,
  primary key (user_id, scope_type, scope_id)
);
alter table sys_user_scopes enable row level security;

insert into sys_roles (code, name, description, system) values
  ('admin', 'Administrator', 'Manages users, roles and settings; sees everything', true),
  ('management', 'Management', 'Owner and management; sees everything', true),
  ('project_manager', 'Project manager', 'Runs projects', true),
  ('procurement', 'Procurement officer', 'Requisitions, orders and vendors', true),
  ('storekeeper', 'Store keeper', 'Receives and issues stock', true),
  ('supervisor', 'Site supervisor', 'Reports from site; limited to assigned projects and teams', true),
  ('accountant', 'Accountant', 'Finance and payments', true),
  ('service_coordinator', 'Service coordinator', 'Maintenance requests and work orders', true),
  ('estimator', 'Estimator', 'Estimates and quotations', true);

-- BR-8: until the accepted role_permissions.csv (P0-03) exists, only the identity and platform
-- permissions are granted. Other modules add their grants when they register their permissions.
insert into sys_role_permissions (role_code, permission_code) values
  ('admin', 'identity.user.manage'),
  ('admin', 'identity.role.manage'),
  ('admin', 'identity.user.read'),
  ('management', 'identity.user.read'),
  ('admin', 'platform.audit.read'),
  ('accountant', 'platform.audit.read'),
  ('admin', 'platform.settings.manage'),
  ('admin', 'platform.series.manage'),
  ('accountant', 'platform.series.manage'),
  ('admin', 'platform.outbox.manage'),
  ('admin', 'platform.backdate.override');
