-- P1-04 Files and notifications: attachment metadata, in-app notifications and scheduled reminders.
-- RLS is enabled with no policies (deny-all). Object bytes live behind the FileStore interface.

create table fil_attachments (
  id uuid primary key,
  entity_type text not null check (entity_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  entity_id uuid not null,
  storage_key text not null check (storage_key <> ''),
  file_name text not null check (file_name <> ''),
  content_type text not null check (content_type in (
    'image/jpeg', 'image/png', 'application/pdf', 'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  caption text,
  taken_at timestamptz,
  latitude numeric(9,6) check (latitude is null or latitude between -90 and 90),
  longitude numeric(9,6) check (longitude is null or longitude between -180 and 180),
  retain_forever boolean not null default false,
  uploaded_by uuid not null,
  purged_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table fil_attachments enable row level security;
create index fil_attachments_entity_idx on fil_attachments (entity_type, entity_id) where deleted_at is null;
-- BR-2: the same bytes attached twice to one entity are one attachment.
create unique index fil_attachments_checksum_uq
  on fil_attachments (entity_type, entity_id, checksum_sha256) where deleted_at is null;
create index fil_attachments_purge_idx on fil_attachments (deleted_at) where deleted_at is not null and purged_at is null;

create table ntf_notifications (
  id uuid primary key,
  user_id uuid not null,
  template text not null check (template <> ''),
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
alter table ntf_notifications enable row level security;
create index ntf_notifications_user_idx on ntf_notifications (user_id, created_at desc);

create table ntf_reminders (
  id uuid primary key,
  user_id uuid not null,
  due_at timestamptz not null,
  template text not null check (template <> ''),
  data jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
alter table ntf_reminders enable row level security;
create index ntf_reminders_due_idx on ntf_reminders (due_at) where sent_at is null;

insert into sys_role_permissions (role_code, permission_code)
select role_code, permission_code
  from (values
    ('admin', 'files.attachment.upload'), ('management', 'files.attachment.upload'),
    ('project_manager', 'files.attachment.upload'), ('procurement', 'files.attachment.upload'),
    ('storekeeper', 'files.attachment.upload'), ('supervisor', 'files.attachment.upload'),
    ('accountant', 'files.attachment.upload'), ('service_coordinator', 'files.attachment.upload'),
    ('estimator', 'files.attachment.upload'),
    ('admin', 'files.attachment.read'), ('management', 'files.attachment.read'),
    ('project_manager', 'files.attachment.read'), ('procurement', 'files.attachment.read'),
    ('storekeeper', 'files.attachment.read'), ('supervisor', 'files.attachment.read'),
    ('accountant', 'files.attachment.read'), ('service_coordinator', 'files.attachment.read'),
    ('estimator', 'files.attachment.read'),
    ('admin', 'files.attachment.remove'), ('management', 'files.attachment.remove'),
    ('project_manager', 'files.attachment.remove'), ('accountant', 'files.attachment.remove')
  ) as t (role_code, permission_code);

-- Every user reads their own notifications: grant to each role that exists now.
insert into sys_role_permissions (role_code, permission_code)
select code, 'notifications.read.own' from sys_roles;
