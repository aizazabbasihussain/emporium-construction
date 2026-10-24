import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findTablesWithoutRls } from './rls.js';
import { createTestDb, withRollback } from './test-db.js';
import type { SqlDb } from './types.js';

describe('createTestDb isolation (T-7)', () => {
  it('writes in one database are absent in the next', async () => {
    const first = await createTestDb();
    await first.exec('create table scratch (id int)');
    await first.query('insert into scratch values ($1)', [1]);
    expect(await first.query('select * from scratch')).toHaveLength(1);

    const second = await createTestDb();
    await expect(second.query('select * from scratch')).rejects.toThrow();
  });

  describe('withRollback', () => {
    let db: SqlDb;
    beforeAll(async () => {
      db = await createTestDb();
      await db.exec('create table scratch (id int)');
    });

    it('sees its own writes inside the callback', async () => {
      const count = await withRollback(db, async (tx) => {
        await tx.query('insert into scratch values ($1)', [1]);
        return (await tx.query('select * from scratch')).length;
      });
      expect(count).toBe(1);
    });

    it('leaves no data behind for the next test', async () => {
      expect(await db.query('select * from scratch')).toEqual([]);
    });

    it('rethrows errors from the callback', async () => {
      await expect(
        withRollback(db, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('does not allow nested transactions', async () => {
      await expect(withRollback(db, (tx) => tx.transaction(async () => 1))).rejects.toThrow(
        /Nested transactions/,
      );
    });
  });
});

describe('row level security guard (BR-7)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rls-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('every table in the real migrations has RLS enabled', async () => {
    const db = await createTestDb();
    expect(await findTablesWithoutRls(db)).toEqual([]);
  });

  it('reports a fixture table that lacks RLS and passes once fixed', async () => {
    await writeFile(path.join(dir, '0001_fixture.sql'), 'create table fix_no_rls (id int);');
    const db = await createTestDb(dir);
    expect(await findTablesWithoutRls(db)).toEqual(['fix_no_rls']);
    await db.exec('alter table fix_no_rls enable row level security');
    expect(await findTablesWithoutRls(db)).toEqual([]);
  });
});
