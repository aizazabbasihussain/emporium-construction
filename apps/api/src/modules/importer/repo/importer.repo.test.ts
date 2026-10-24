import { createTestDb, type SqlDb } from '@emporium/db';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  findBatch,
  hasCommitted,
  hasCommittedHash,
  insertBatch,
  insertErrors,
  listBatches,
  listErrors,
  markCommitted,
  markRolledBack,
} from './importer.repo.js';

let db: SqlDb;
const id = (n: number) => `018f6666-0000-7000-8000-${String(n).padStart(12, '0')}`;
const user = id(900);
const hash = (c: string) => c.repeat(64);

const batch = (n: number, over: Partial<Parameters<typeof insertBatch>[1]> = {}) => ({
  id: id(n),
  importerCode: 'clients',
  fileName: 'clients.csv',
  fileHash: hash('a'),
  status: 'dry_run_ok' as const,
  rowCount: 2,
  errorCount: 0,
  dryRunAt: new Date(`2026-10-24T10:0${n}:00Z`),
  actorUserId: user,
  ...over,
});

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe('imp_batches', () => {
  it('inserts and finds a batch', async () => {
    await insertBatch(db, batch(1));
    expect(await findBatch(db, id(1))).toMatchObject({
      id: id(1),
      importer_code: 'clients',
      status: 'dry_run_ok',
      forced: false,
      row_count: 2,
      created_by: user,
      version: 1,
    });
    expect(await findBatch(db, id(404))).toBeUndefined();
  });

  it('lists newest first, filtered and paged', async () => {
    await insertBatch(db, batch(2, { importerCode: 'vendors', fileHash: hash('b') }));
    await insertBatch(db, batch(3, { fileHash: hash('c') }));
    expect((await listBatches(db, { limit: 10, offset: 0 })).map((b) => b.id)).toEqual([
      id(3),
      id(2),
      id(1),
    ]);
    expect(
      (await listBatches(db, { importerCode: 'clients', limit: 10, offset: 0 })).map((b) => b.id),
    ).toEqual([id(3), id(1)]);
    expect((await listBatches(db, { limit: 1, offset: 1 })).map((b) => b.id)).toEqual([id(2)]);
  });

  it('commits only a dry-run-ok batch, once, and bumps the version', async () => {
    const at = new Date('2026-10-24T12:00:00Z');
    expect(await markCommitted(db, id(1), { forced: false, at, actorUserId: user })).toBe(true);
    expect(await markCommitted(db, id(1), { forced: false, at, actorUserId: user })).toBe(false);
    expect(await findBatch(db, id(1))).toMatchObject({
      status: 'committed',
      committed_at: at,
      version: 2,
    });
    expect(await hasCommitted(db, 'clients')).toBe(true);
    expect(await hasCommitted(db, 'vendors')).toBe(false);
    expect(await hasCommittedHash(db, 'clients', hash('a'))).toBe(true);
    expect(await hasCommittedHash(db, 'clients', hash('c'))).toBe(false);
  });

  it('rolls back only a dry-run-ok batch', async () => {
    const at = new Date('2026-10-24T12:00:00Z');
    await markRolledBack(db, id(3), { at, actorUserId: user });
    await markRolledBack(db, id(1), { at, actorUserId: user });
    expect((await findBatch(db, id(3)))?.status).toBe('rolled_back');
    expect((await findBatch(db, id(1)))?.status).toBe('committed');
  });

  it('allows one committed batch per file unless forced (unique index)', async () => {
    await insertBatch(db, batch(4));
    await expect(
      markCommitted(db, id(4), { forced: false, at: new Date(), actorUserId: user }),
    ).rejects.toThrow(/imp_batches_committed_hash_uq/);
    expect(
      await markCommitted(db, id(4), { forced: true, at: new Date(), actorUserId: user }),
    ).toBe(true);
  });

  it('rejects malformed hashes and statuses', async () => {
    await expect(insertBatch(db, batch(5, { fileHash: 'xyz' }))).rejects.toThrow();
    await expect(insertBatch(db, batch(6, { status: 'weird' as 'committed' }))).rejects.toThrow();
  });
});

describe('imp_errors', () => {
  it('stores many errors in chunks and returns them in row order', async () => {
    const errors = Array.from({ length: 1203 }, (_, i) => ({
      rowNo: 1203 - i,
      column: 'Name',
      message: `m${i}`,
    }));
    await insertErrors(db, id(2), errors);
    await insertErrors(db, id(2), []);
    const all = await listErrors(db, id(2));
    expect(all).toHaveLength(1203);
    expect(all[0]).toEqual({ rowNo: 1, column: 'Name', message: 'm1202' });
    expect(await listErrors(db, id(2), 2)).toHaveLength(2);
    expect(await listErrors(db, id(1))).toEqual([]);
  });
});
