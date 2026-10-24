import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SqlDb } from './types.js';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  number: number;
  name: string;
  sql: string;
  checksum: string;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

const BOOKKEEPING_SQL = `
create table if not exists sys_migrations (
  id serial primary key,
  name text not null unique,
  checksum text not null,
  applied_at timestamptz not null default now()
);
alter table sys_migrations enable row level security;
`;

export const checksumOf = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry);
    if (!match) throw new MigrationError(`Invalid migration file name: ${entry}`);
    const sql = await readFile(path.join(dir, entry), 'utf8');
    files.push({ number: Number(match[1]), name: entry, sql, checksum: checksumOf(sql) });
  }
  files.forEach((file, index) => {
    const previous = files[index - 1];
    if (previous && file.number === previous.number) {
      throw new MigrationError(`Duplicate migration number ${file.number}`);
    }
    const expected = index + 1;
    if (file.number !== expected) {
      throw new MigrationError(
        `Migration numbering gap: expected ${String(expected).padStart(4, '0')} but found ${file.name}`,
      );
    }
  });
  return files;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(db: SqlDb, dir: string): Promise<MigrationResult> {
  const files = await loadMigrationFiles(dir);
  await db.exec(BOOKKEEPING_SQL);
  const rows = await db.query<{ name: string; checksum: string }>(
    'select name, checksum from sys_migrations order by id',
  );
  const recorded = new Map(rows.map((r) => [r.name, r.checksum]));

  const known = new Set(files.map((f) => f.name));
  for (const name of recorded.keys()) {
    if (!known.has(name)) throw new MigrationError(`Applied migration ${name} is missing on disk`);
  }
  for (const file of files) {
    const checksum = recorded.get(file.name);
    if (checksum !== undefined && checksum !== file.checksum) {
      throw new MigrationError(`Checksum mismatch for applied migration ${file.name}`);
    }
  }

  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of files) {
    if (recorded.has(file.name)) {
      result.skipped.push(file.name);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.exec(file.sql);
      await tx.query('insert into sys_migrations (name, checksum) values ($1, $2)', [
        file.name,
        file.checksum,
      ]);
    });
    result.applied.push(file.name);
  }
  return result;
}
