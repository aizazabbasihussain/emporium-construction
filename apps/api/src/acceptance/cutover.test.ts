import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '@emporium/db';
import { describe, expect, it } from 'vitest';
import { checkParallelRunLog, compareOpening, parseControlSheet } from './cutover.js';
import { loadedOpeningTotals, verifyOpening } from './opening.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/cutover');
const doc = (name: string) => readFileSync(path.join(DOCS, name), 'utf8');

const sheet = [
  '| Key | What | Total |',
  '| --- | --- | --- |',
  '| `cash.cash_ho` | Cash | `500000.00` |',
  '| `bank.bank_1` | Bank | `2000000.00` |',
].join('\n');

describe('Opening verification (P2-10 T-3, BR-1)', () => {
  it('reads the control sheet of the repository', () => {
    expect(parseControlSheet(doc('opening-control-sheet.md'))).toEqual([
      { key: 'cash.cash_ho', label: 'Head office cash on hand (CASH-HO)', total: '500000.00' },
      { key: 'bank.bank_1', label: 'Synthetic Bank current account (BANK-1)', total: '2000000.00' },
    ]);
  });

  it('finds no difference when every total matches', () => {
    expect(
      compareOpening(parseControlSheet(sheet), {
        'cash.cash_ho': '500000.00',
        'bank.bank_1': '2000000.00',
      }),
    ).toEqual([]);
  });

  it('reports a mismatch to the paisa, a missing total and an unexpected one', () => {
    const found = compareOpening(parseControlSheet(sheet), {
      'cash.cash_ho': '499999.99',
      'cash.extra': '10.00',
    });
    expect(found).toEqual([
      { key: 'cash.cash_ho', controlSheet: '500000.00', loaded: '499999.99', difference: '-0.01' },
      {
        key: 'bank.bank_1',
        controlSheet: '2000000.00',
        loaded: 'not loaded',
        difference: '-2000000.00',
      },
      {
        key: 'cash.extra',
        controlSheet: 'not on the control sheet',
        loaded: '10.00',
        difference: '10.00',
      },
    ]);
  });

  it('compares the opening balances of a loaded database', async () => {
    const db = await createTestDb();
    const account = (code: string, kind: string, amount: string) =>
      db.exec(
        `insert into cbk_accounts (id, code, name, kind, opening_balance, opening_date)
         values (gen_random_uuid(), '${code}', '${code}', '${kind}', ${amount}, '2026-11-01')`,
      );
    await account('CASH-HO', 'cash', '500000.00');
    await account('BANK-1', 'bank', '2000000.00');
    expect(await loadedOpeningTotals(db)).toEqual({
      'cash.cash_ho': '500000.00',
      'bank.bank_1': '2000000.00',
    });
    expect(await verifyOpening(db, doc('opening-control-sheet.md'))).toEqual([]);
    // The opening balance is immutable once set, so a mismatch needs a database loaded differently.
    const other = await createTestDb();
    await other.exec(
      `insert into cbk_accounts (id, code, name, kind, opening_balance, opening_date)
       values (gen_random_uuid(), 'CASH-HO', 'x', 'cash', 500000.00, '2026-11-01'),
              (gen_random_uuid(), 'BANK-1', 'y', 'bank', 1999999.99, '2026-11-01')`,
    );
    const found = await verifyOpening(other, doc('opening-control-sheet.md'));
    expect(found.map((d) => [d.key, d.difference])).toEqual([['bank.bank_1', '-0.01']]);
  }, 60_000);
});

const day = (date: string, unexplained = 0, cash = 'ok') =>
  `| ${date} | ${cash} | ok | ok | ok | ok | ok | ${unexplained} | |`;

const run = (n: number, mutate?: (date: string, i: number) => string) =>
  Array.from({ length: n }, (_, i) => {
    const date = `2026-12-${String(i + 1).padStart(2, '0')}`;
    return mutate ? mutate(date, i) : day(date);
  }).join('\n');

describe('Parallel run log format checker (P2-10 T-7, BR-9)', () => {
  it('accepts the empty log of the repository: no days, so the gate to stop paper is not met', () => {
    const report = checkParallelRunLog(doc('parallel-run-log.md'));
    expect(report.days).toEqual([]);
    expect(report.problems).toEqual([]);
    expect(report.cleanLastTen).toBe(false);
  });

  it('passes ten clean days', () => {
    const report = checkParallelRunLog(run(10));
    expect(report.problems).toEqual([]);
    expect(report.cleanLastTen).toBe(true);
  });

  it('is not clean with fewer than ten days or with an unexplained difference in the last ten', () => {
    expect(checkParallelRunLog(run(9)).cleanLastTen).toBe(false);
    expect(checkParallelRunLog(run(12, (d, i) => day(d, i === 1 ? 2 : 0))).cleanLastTen).toBe(true);
    expect(checkParallelRunLog(run(12, (d, i) => day(d, i === 5 ? 2 : 0))).cleanLastTen).toBe(
      false,
    );
  });

  it('flags malformed rows instead of skipping them', () => {
    const log = [
      '| 2026-12-01 | ok | ok |',
      '| 2026-12-02 | ok | ok | ok | ok | ok | ok | many | |',
      '| 2026-12-03 | | ok | ok | ok | ok | ok | 0 | |',
      day('2026-12-04', 0, 'differs by 500'),
      day('2026-12-05'),
      day('2026-12-05'),
      '| 2026-13-45 | ok | ok | ok | ok | ok | ok | 0 | |',
    ].join('\n');
    const { problems } = checkParallelRunLog(log);
    expect(problems).toEqual([
      '2026-12-01: expected 8 or more columns, found 3',
      '2026-12-02: the unexplained column must be a whole number',
      '2026-12-03: nothing recorded for cash',
      '2026-12-04: a difference is recorded but the unexplained count is 0',
      '2026-13-45: not a real date',
      '2026-12-05: recorded twice',
    ]);
  });
});
