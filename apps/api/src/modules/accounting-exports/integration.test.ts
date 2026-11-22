import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accountingPermissions, filesPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileStore, createFiles, type Files } from '../files/index.js';
import { createAccounting, type Accounting } from './index.js';
import {
  ACCOUNTANT,
  MANAGEMENT,
  SUPERVISOR,
  createAccountingKit,
  type AccountingKit,
} from './test-support.js';
import type { Actor, Db } from './types.js';

const empty = async () => ({ items: [], total: 0, limit: 200, offset: 0 });

let kit: AccountingKit;
let directory: string;
let files: Files;
let accounting: Accounting;

const receipts = [
  {
    id: 'rc1',
    number: 'RV-2026-0001',
    partyId: 'c1',
    receiptDate: '2026-10-08',
    method: 'cash',
    amount: '1500.00',
    withheldAmount: '0.00',
    status: 'cleared',
    allocations: [],
    reference: null,
  },
];

beforeAll(async () => {
  kit = await createAccountingKit();
  directory = await mkdtemp(path.join(tmpdir(), 'accounting-files-'));
  const clock = { now: () => new Date(kit.now.current) };
  let n = 0;
  const newId = () => `018f7c7c-cccc-7000-8000-${String(++n).padStart(12, '0')}`;
  const { store } = createFileStore(
    {
      driver: 'local',
      local: {
        directory,
        secret: 'kit-secret-kit-secret-kit',
        baseUrl: 'https://api.example.test',
      },
    },
    clock.now,
  );
  files = createFiles({ platform: kit.platform, clock, newId, newKey: randomUUID, store });
  accounting = createAccounting({
    platform: kit.platform,
    clock,
    newId,
    files,
    receivables: {
      receipts: { list: async () => ({ items: receipts, total: 1, limit: 200, offset: 0 }) },
      getCustomerBalance: async (_db: Db, _id: string, date: string) => ({
        receipts: date >= '2026-10-08' ? '1500.00' : '0.00',
        withholding: '0.00',
      }),
    },
    masterData: { getParty: async () => ({ name: 'Synthetic Client' }) },
    // The other owning modules have nothing in this scenario.
    billing: { invoices: { list: empty }, creditNotes: { listForInvoice: async () => [] } },
    payables: { bills: { list: empty }, payments: { list: empty } },
    cashbook: { transactions: { list: empty } },
    payroll: { runs: { list: empty } },
    valuation: { reports: { movements: empty } },
    expenses: { claims: { list: empty } },
  } as never);
}, 120_000);
afterAll(async () => {
  await kit.close();
  await rm(directory, { recursive: true, force: true });
});

const actorWith = (userId: string, permissions: string[]): Actor => ({
  ...kit.actorFor(userId),
  permissions: new Set(permissions),
});
const accountant = () =>
  actorWith(ACCOUNTANT, [...Object.values(accountingPermissions), filesPermissions.read]);

describe('the files of a run, through the real file store (BR-6, BR-8)', () => {
  it('stores an Excel and a CSV file the accountant can open, and nobody else', async () => {
    // Management may run exports but holds no file upload permission: the run still stores its files.
    const runner = actorWith(MANAGEMENT, [
      accountingPermissions.exportRun,
      accountingPermissions.exportRead,
    ]);
    const result = await kit.db.transaction((tx) =>
      accounting.runExport(
        'receipts_register',
        { from: '2026-10-01', to: '2026-10-31' },
        runner,
        tx,
      ),
    );
    expect(result.totals).toEqual({ amount: '1500.00', withheld: '0.00' });
    const listed = await files.list(kit.db, accountant(), 'acc_export_run', result.run.id);
    expect(
      listed
        .map((f) => [f.fileName, f.contentType])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['receipts_register-2026-10-01-2026-10-31.csv', 'text/csv'],
      [
        'receipts_register-2026-10-01-2026-10-31.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
    ]);
    expect(listed.map((f) => f.id).sort()).toEqual([result.files.csv, result.files.xlsx].sort());
    expect(listed.every((f) => f.checksumSha256.length === 64)).toBe(true);
    for (const id of [result.files.xlsx, result.files.csv]) {
      expect((await files.getSignedUrl(kit.db, accountant(), id)).url).toContain('https://');
    }
    // A user with file access but no accounting permission cannot open a run's files.
    const outsider = actorWith(SUPERVISOR, [filesPermissions.read]);
    await expect(files.getSignedUrl(kit.db, outsider, result.files.xlsx)).rejects.toThrow();
    // Nor can anyone remove or replace them.
    await expect(files.remove(result.files.xlsx, accountant(), kit.db as never)).rejects.toThrow();
  });

  it('exposes the tagging interfaces other modules may call', async () => {
    const tag = await kit.db.transaction((tx) =>
      accounting.tagTransaction({ docType: 'receipt', docId: 'rc1' }, '1210', accountant(), tx),
    );
    expect(tag).toMatchObject({ accountCode: '1210', method: 'manual' });
    const page = await accounting.listUntagged(kit.db, { limit: 5, offset: 0 }, accountant());
    expect(page.total).toBeGreaterThanOrEqual(0);
  });
});
