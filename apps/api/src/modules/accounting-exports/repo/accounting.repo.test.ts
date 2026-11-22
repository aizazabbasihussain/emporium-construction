import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccountingKit, uid, type AccountingKit } from '../test-support.js';
import {
  findAccount,
  findRule,
  findTag,
  insertRule,
  insertRun,
  insertTagIfAbsent,
  listAccounts,
  listRules,
  listRuns,
  listTaggedKeys,
  listTagsOfDocs,
  setAccountActive,
  updateRule,
  upsertTag,
} from './accounting.repo.js';

let kit: AccountingKit;
beforeAll(async () => {
  kit = await createAccountingKit();
}, 120_000);
afterAll(() => kit.close());

const at = new Date('2026-10-25T10:00:00Z');
const values = {
  sourceDocType: 'invoice',
  condition: { kind: 'advance' },
  debitAccountCode: '1210',
  creditAccountCode: '4100',
  effectiveFrom: '2026-07-01',
  active: true,
};

describe('accounts', () => {
  it('reads the seeded chart, finds one and switches it off with a version check', async () => {
    expect((await listAccounts(kit.db, true)).length).toBeGreaterThan(60);
    expect(await findAccount(kit.db, '1110')).toMatchObject({
      name: 'Cash in hand',
      type: 'asset',
      parent_code: '1100',
      active: true,
      version: 1,
    });
    expect(await findAccount(kit.db, 'nope')).toBeUndefined();
    expect(await setAccountActive(kit.db, '1120', 9, false, null, at)).toBeUndefined();
    expect(await setAccountActive(kit.db, '1120', 1, false, uid(3), at)).toMatchObject({
      active: false,
      version: 2,
    });
    expect((await listAccounts(kit.db, false)).some((a) => a.code === '1120')).toBe(false);
    expect((await listAccounts(kit.db, true)).some((a) => a.code === '1120')).toBe(true);
  });

  it('is a tree: every parent code is an account of the chart', async () => {
    const accounts = await listAccounts(kit.db, true);
    const codes = new Set(accounts.map((a) => a.code));
    for (const account of accounts) {
      if (account.parent_code !== null) expect(codes.has(account.parent_code)).toBe(true);
    }
  });
});

describe('mapping rules', () => {
  it('inserts, reads, lists and updates with a version check', async () => {
    const id = uid(100);
    const row = await insertRule(kit.db, id, values, uid(3), at);
    expect(row).toMatchObject({
      id,
      source_doc_type: 'invoice',
      condition: { kind: 'advance' },
      debit_account_code: '1210',
      credit_account_code: '4100',
      effective_from: '2026-07-01',
      active: true,
      version: 1,
    });
    expect(await findRule(kit.db, id)).toEqual(row);
    expect(await findRule(kit.db, uid(999))).toBeUndefined();
    expect((await listRules(kit.db)).map((r) => r.id)).toContain(id);
    expect(
      await updateRule(kit.db, id, 5, { ...values, active: false }, uid(3), at),
    ).toBeUndefined();
    expect(
      await updateRule(kit.db, id, 1, { ...values, active: false, condition: {} }, uid(3), at),
    ).toMatchObject({ active: false, condition: {}, version: 2 });
  });

  it('refuses an account that is not in the chart and a document type that is not taggable', async () => {
    await expect(
      insertRule(kit.db, uid(101), { ...values, debitAccountCode: '9999' }, null, at),
    ).rejects.toThrow();
    await expect(
      insertRule(kit.db, uid(102), { ...values, sourceDocType: 'journal' }, null, at),
    ).rejects.toThrow();
  });
});

describe('tags', () => {
  const tag = {
    docType: 'bill',
    docId: 'b-1',
    lineRef: '',
    accountCode: '5100',
    by: null,
    method: 'manual',
  };

  it('upserts one tag per line and reads it back', async () => {
    const first = await upsertTag(kit.db, tag, at);
    expect(first).toMatchObject({ account_code: '5100', method: 'manual', tagged_by: null });
    const changed = await upsertTag(
      kit.db,
      { ...tag, accountCode: '5300', by: uid(3), method: 'rule' },
      new Date('2026-10-26T10:00:00Z'),
    );
    expect(changed).toMatchObject({ account_code: '5300', method: 'rule', tagged_by: uid(3) });
    expect(await findTag(kit.db, 'bill', 'b-1', '')).toEqual(changed);
    expect(await findTag(kit.db, 'bill', 'b-1', '9')).toBeUndefined();
  });

  it('inserts a rule tag only when the line has none', async () => {
    const line = { docType: 'receipt', docId: 'r-1', lineRef: '', accountCode: '1210', by: null };
    expect(await insertTagIfAbsent(kit.db, line, at)).toBe(true);
    expect(await insertTagIfAbsent(kit.db, { ...line, accountCode: '4100' }, at)).toBe(false);
    expect((await findTag(kit.db, 'receipt', 'r-1', ''))?.account_code).toBe('1210');
    expect((await findTag(kit.db, 'receipt', 'r-1', ''))?.method).toBe('rule');
  });

  it('lists the tags of given documents and every tagged key', async () => {
    await upsertTag(kit.db, { ...tag, docId: 'b-2', lineRef: '2' }, at);
    const rows = await listTagsOfDocs(kit.db, 'bill', ['b-1', 'b-2', 'b-3']);
    expect(rows.map((r) => `${r.source_doc_id}|${r.line_ref}`).sort()).toEqual(['b-1|', 'b-2|2']);
    expect(await listTagsOfDocs(kit.db, 'bill', [])).toEqual([]);
    const keys = await listTaggedKeys(kit.db);
    expect(keys.has('bill|b-2|2')).toBe(true);
    expect(keys.has('bill|b-3|')).toBe(false);
  });

  it('refuses an account that is not in the chart and a method that is not allowed', async () => {
    await expect(upsertTag(kit.db, { ...tag, accountCode: '9999' }, at)).rejects.toThrow();
    await expect(upsertTag(kit.db, { ...tag, method: 'guess' }, at)).rejects.toThrow();
  });
});

describe('export runs', () => {
  const run = (n: number, code = 'aging') => ({
    id: uid(200 + n),
    exportCode: code,
    schemaVersion: 1,
    filters: { from: '2026-10-01', to: '2026-10-31' },
    rowCount: n,
    checksum: 'a'.repeat(64),
    fileId: null,
    by: uid(3),
  });

  it('logs runs and lists them newest first, by export code, with a count', async () => {
    const first = await insertRun(kit.db, run(1), new Date('2026-10-25T10:00:00Z'));
    expect(first).toMatchObject({
      id: uid(201),
      export_code: 'aging',
      schema_version: 1,
      filters: { from: '2026-10-01', to: '2026-10-31' },
      row_count: 1,
      file_id: null,
      run_by: uid(3),
    });
    await insertRun(kit.db, run(2), new Date('2026-10-26T10:00:00Z'));
    await insertRun(kit.db, run(3, 'sales_register'), new Date('2026-10-27T10:00:00Z'));
    const all = await listRuns(kit.db, { limit: 10, offset: 0 });
    expect(all.rows.map((r) => r.row_count)).toEqual([3, 2, 1]);
    expect(all.total).toBe(3);
    const aging = await listRuns(kit.db, { exportCode: 'aging', limit: 1, offset: 1 });
    expect(aging.rows.map((r) => r.row_count)).toEqual([1]);
    expect(aging.total).toBe(2);
  });

  it('refuses a checksum that is not 64 hex characters', async () => {
    await expect(
      insertRun(kit.db, { ...run(9), id: uid(299), checksum: 'xyz' }, at),
    ).rejects.toThrow();
  });
});

describe('row level security (constitution 7.7)', () => {
  it('is enabled on every table of the module', async () => {
    const rows = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname like 'acc\\_%' and relkind = 'r'`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([
      'acc_accounts',
      'acc_export_runs',
      'acc_mapping_rules',
      'acc_tags',
    ]);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
