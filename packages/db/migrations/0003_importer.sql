-- P0-04 Importer: batches and per-row validation errors. Uploaded files are never stored (BR-10);
-- only the hash and metadata persist. RLS is enabled with no policies (deny-all).

create table imp_batches (
  id uuid primary key,
  importer_code text not null check (importer_code ~ '^[a-z][a-z0-9_]*$'),
  file_name text not null check (file_name <> ''),
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('dry_run_ok', 'dry_run_failed', 'committed', 'rolled_back')),
  forced boolean not null default false,
  row_count integer not null default 0 check (row_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  dry_run_at timestamptz,
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  version integer not null default 1,
  deleted_at timestamptz
);
alter table imp_batches enable row level security;

-- One committed batch per importer and file; a forced re-import (BR-4) is the only way around it.
create unique index imp_batches_committed_hash_uq
  on imp_batches (importer_code, file_hash)
  where status = 'committed' and not forced;
create index imp_batches_importer_idx on imp_batches (importer_code, status);
create index imp_batches_created_idx on imp_batches (created_at desc);

create table imp_errors (
  id bigint generated always as identity primary key,
  batch_id uuid not null references imp_batches (id),
  row_no integer not null check (row_no >= 1),
  column_name text not null,
  message text not null
);
alter table imp_errors enable row level security;
create index imp_errors_batch_idx on imp_errors (batch_id, row_no, id);

insert into sys_role_permissions (role_code, permission_code) values
  ('admin', 'importer.batch.run'),
  ('accountant', 'importer.batch.run'),
  ('admin', 'importer.batch.force'),
  ('admin', 'importer.batch.read'),
  ('accountant', 'importer.batch.read'),
  ('management', 'importer.batch.read');
