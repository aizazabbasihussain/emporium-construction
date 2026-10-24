import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, checksumOf, loadMigrationFiles, runMigrations } from './migrations.js';
import { fromPglite } from './pglite.js';
import type { SqlDb } from './types.js';

let dir: string;
let db: SqlDb;
let pg: PGlite;

const write = (name: string, sql: string) => writeFile(path.join(dir, name), sql);

// PGlite starts slowly, so one instance is shared and the schema is reset for each test.
beforeAll(() => {
  pg = new PGlite();
  db = fromPglite(pg);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
  await pg.exec('drop schema public cascade; create schema public;');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migration runner (T-1)', () => {
  it('applies migrations in order and records name and checksum', async () => {
    await write(
      '0001_first.sql',
      'create table a_one (id int); alter table a_one enable row level security;',
    );
    await write(
      '0002_second.sql',
      'create table a_two (id int); alter table a_two enable row level security;',
    );
    const result = await runMigrations(db, dir);
    expect(result.applied).toEqual(['0001_first.sql', '0002_second.sql']);
    const rows = await db.query<{ name: string; checksum: string }>(
      'select name, checksum from sys_migrations order by id',
    );
    expect(rows.map((r) => r.name)).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(rows[0]?.checksum).toBe(
      checksumOf('create table a_one (id int); alter table a_one enable row level security;'),
    );
  });

  it('is idempotent on re-run', async () => {
    await write('0001_first.sql', 'create table a_one (id int);');
    await runMigrations(db, dir);
    const again = await runMigrations(db, dir);
    expect(again).toEqual({ applied: [], skipped: ['0001_first.sql'] });
  });

  it('applies only new files on a later run', async () => {
    await write('0001_first.sql', 'create table a_one (id int);');
    await runMigrations(db, dir);
    await write('0002_second.sql', 'create table a_two (id int);');
    const result = await runMigrations(db, dir);
    expect(result).toEqual({ applied: ['0002_second.sql'], skipped: ['0001_first.sql'] });
  });

  it('rejects a changed checksum on an applied file', async () => {
    await write('0001_first.sql', 'create table a_one (id int);');
    await runMigrations(db, dir);
    await write('0001_first.sql', 'create table a_one (id int, extra int);');
    await expect(runMigrations(db, dir)).rejects.toThrow(/Checksum mismatch.*0001_first\.sql/);
  });

  it('rejects an applied migration that is missing on disk', async () => {
    await write('0001_first.sql', 'create table a_one (id int);');
    await runMigrations(db, dir);
    await rm(path.join(dir, '0001_first.sql'));
    await expect(runMigrations(db, dir)).rejects.toThrow(/missing on disk/);
  });

  it('rejects a numbering gap', async () => {
    await write('0001_first.sql', 'select 1;');
    await write('0003_third.sql', 'select 1;');
    await expect(runMigrations(db, dir)).rejects.toThrow(/gap: expected 0002/);
  });

  it('rejects a duplicate number', async () => {
    await write('0001_first.sql', 'select 1;');
    await write('0001_other.sql', 'select 1;');
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/Duplicate migration number 1/);
  });

  it('rejects a badly named file', async () => {
    await write('first.sql', 'select 1;');
    await expect(loadMigrationFiles(dir)).rejects.toBeInstanceOf(MigrationError);
  });

  it('rolls back a failing migration without recording it', async () => {
    await write('0001_first.sql', 'create table a_one (id int);');
    await write('0002_bad.sql', 'create table a_two (id int); select * from does_not_exist;');
    await expect(runMigrations(db, dir)).rejects.toThrow();
    const recorded = await db.query<{ name: string }>('select name from sys_migrations');
    expect(recorded.map((r) => r.name)).toEqual(['0001_first.sql']);
    const tables = await db.query<{ relname: string }>(
      "select relname from pg_class where relname = 'a_two'",
    );
    expect(tables).toEqual([]);
  });
});
