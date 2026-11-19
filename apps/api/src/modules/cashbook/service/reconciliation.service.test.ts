import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, createCashbookKit, uid, type CashbookKit } from '../test-support.js';
import type { AccountDto, TransactionDto } from '../types.js';

let kit: CashbookKit;
let bank: AccountDto;
let t1: TransactionDto;
let t2: TransactionDto;
let t3: TransactionDto;

const CSV = [
  'date,description,debit,credit',
  '2026-11-13,Deposit,,500.00',
  '2026-11-16,"Cheque, clearing",,300.00',
  '16/11/2026,Interest,,10.00',
].join('\n');

const create = (closing: string, over: Record<string, string> = {}) =>
  kit.tx((tx) =>
    kit.cashbook.reconciliation.create(
      {
        accountId: bank.id,
        statementFrom: '2026-11-01',
        statementTo: '2026-11-16',
        statementClosingBalance: closing,
        ...over,
      },
      kit.actor,
      tx,
    ),
  );
const importCsv = (id: string, csv = CSV) =>
  kit.tx((tx) => kit.cashbook.reconciliation.importStatement(id, csv, kit.actor, tx));
const match = (id: string, matches: { lineId: string; transactionId: string | null }[]) =>
  kit.tx((tx) => kit.cashbook.reconciliation.match(id, matches, kit.actor, tx));
const complete = (id: string, version: number) =>
  kit.tx((tx) => kit.cashbook.reconciliation.complete(id, version, kit.actor, tx));
const reopen = (id: string) =>
  kit.tx((tx) => kit.cashbook.reconciliation.reopen(id, kit.actor, tx));

beforeAll(async () => {
  kit = await createCashbookKit();
  // Three days before "today" are allowed, so the books are kept on the 16th.
  kit.now.current = new Date('2026-11-16T10:00:00Z');
  await kit.setting('cashbook.payment_approval_threshold', '999999999');
  bank = await kit.account({ kind: 'bank', openingBalance: '1000' });
  const post = (kind: 'in' | 'out', amount: string, txnDate: string) =>
    kit.tx((tx) =>
      kind === 'in'
        ? kit.cashbook.recordReceipt(
            { accountId: bank.id, txnDate, amount, method: 'bank_transfer' },
            kit.actor,
            tx,
          )
        : kit.cashbook.recordPayment(
            { accountId: bank.id, txnDate, amount, method: 'cheque' },
            kit.actor,
            tx,
          ),
    );
  t1 = await post('in', '500', '2026-11-13');
  t2 = await post('out', '200', '2026-11-14');
  t3 = await post('in', '300', '2026-11-15');
}, 120_000);
afterAll(() => kit.close());

describe('statement import and suggestions (BR-8, T-7)', () => {
  it('imports CSV lines (both date formats, quoted commas) and suggests matches by amount and date', async () => {
    const draft = await create('1810');
    const detail = await importCsv(draft.id);
    expect(
      detail.lines.map((l) => [l.lineNo, l.lineDate, l.description, l.debit, l.credit]),
    ).toEqual([
      [1, '2026-11-13', 'Deposit', '0.00', '500.00'],
      [2, '2026-11-16', 'Cheque, clearing', '0.00', '300.00'],
      [3, '2026-11-16', 'Interest', '0.00', '10.00'],
    ]);
    const [first, second] = detail.lines;
    expect(detail.suggestions).toEqual([
      { lineId: first?.id, transactionId: t1.id, dayDifference: 0 },
      { lineId: second?.id, transactionId: t3.id, dayDifference: 1 },
    ]);
    expect(detail.candidates.map((c) => c.id).sort()).toEqual([t1.id, t2.id, t3.id].sort());
    // The cheque (T2) is outstanding and the interest (line 3) is not booked: both sides are open.
    expect(detail.figures).toEqual({
      bookBalance: '1600.00',
      bookUnreconciled: '600.00',
      statementUnreconciled: '810.00',
      expectedClosing: '1810.00',
      difference: '0.00',
    });
  });

  it('a new import replaces the lines and the matches of the draft', async () => {
    const draft = await create('1810');
    const first = await importCsv(draft.id);
    await match(draft.id, [{ lineId: first.lines[0]?.id as string, transactionId: t1.id }]);
    const again = await importCsv(draft.id, 'date,description,debit,credit\n2026-11-15,Only,,300');
    expect(again.lines).toHaveLength(1);
    expect(again.candidates.map((c) => c.id)).toContain(t1.id);
  });

  it('refuses a wrong header, a line outside the period, an import after completion', async () => {
    const draft = await create('1810');
    await expect(importCsv(draft.id, 'a,b,c\n1,2,3')).rejects.toMatchObject({
      code: 'statement_header_invalid',
    });
    await expect(
      importCsv(draft.id, 'date,description,debit,credit\n2026-12-01,Late,,5'),
    ).rejects.toMatchObject({ code: 'statement_line_out_of_period' });
    await expect(importCsv(uid(950))).rejects.toMatchObject({ code: 'reconciliation_not_found' });
  });

  it('does not suggest a transaction more than three days from the line', async () => {
    const draft = await create('0');
    const detail = await importCsv(draft.id, 'date,description,debit,credit\n2026-11-02,Old,,500');
    expect(detail.suggestions).toEqual([]);
  });
});

describe('matching (BR-8)', () => {
  it('confirms, changes and clears matches; only the same money matches', async () => {
    const draft = await create('1810');
    const { lines } = await importCsv(draft.id);
    const deposit = lines[0] as { id: string };
    const cheque = lines[1] as { id: string };
    let detail = await match(draft.id, [
      { lineId: deposit.id, transactionId: t1.id },
      { lineId: cheque.id, transactionId: t3.id },
    ]);
    expect(detail.lines.map((l) => l.matchedTransactionId)).toEqual([t1.id, t3.id, null]);
    expect(detail.candidates.map((c) => c.id)).toEqual([t2.id]);
    expect(detail.suggestions).toEqual([]);

    // The same line moves to another transaction when matched again; null clears it.
    await expect(
      match(draft.id, [{ lineId: deposit.id, transactionId: t2.id }]),
    ).rejects.toMatchObject({
      code: 'match_mismatch',
    });
    detail = await match(draft.id, [{ lineId: deposit.id, transactionId: null }]);
    expect(detail.lines[0]?.matchedTransactionId).toBeNull();
    expect(detail.candidates.map((c) => c.id)).toContain(t1.id);
    detail = await match(draft.id, [{ lineId: deposit.id, transactionId: t1.id }]);
    expect(detail.lines[0]?.matchedTransactionId).toBe(t1.id);
    // Matching the same pair again is harmless.
    await match(draft.id, [{ lineId: deposit.id, transactionId: t1.id }]);

    // A transaction waits in one line only; an unknown line or transaction is not found.
    await expect(
      match(draft.id, [{ lineId: cheque.id, transactionId: t1.id }]),
    ).rejects.toMatchObject({
      code: 'transaction_not_found',
    });
    await expect(
      match(draft.id, [{ lineId: uid(951), transactionId: null }]),
    ).rejects.toMatchObject({
      code: 'statement_line_not_found',
    });
    // A transaction matched in one draft is not offered to another, so release them.
    await match(draft.id, [
      { lineId: deposit.id, transactionId: null },
      { lineId: cheque.id, transactionId: null },
    ]);
  });
});

describe('completion and un-reconciling (BR-8, AC-2)', () => {
  it('stays a draft with the difference shown until the figures agree', async () => {
    const wrong = await create('1815');
    await importCsv(wrong.id);
    await expect(complete(wrong.id, wrong.version)).rejects.toMatchObject({
      code: 'reconciliation_difference',
      details: { difference: '5.00' },
    });
    const after = await kit.cashbook.reconciliation.get(kit.db, wrong.id);
    expect(after).toMatchObject({ status: 'draft', completedAt: null });
    expect(after.figures.difference).toBe('5.00');
  });

  it('completes at zero with unreconciled items on both sides, flags the matches and blocks their reversal', async () => {
    const draft = await create('1810');
    const { lines, suggestions } = await importCsv(draft.id);
    await match(
      draft.id,
      suggestions.map((s) => ({ lineId: s.lineId, transactionId: s.transactionId })),
    );
    expect(lines).toHaveLength(3);
    await expect(complete(draft.id, 99)).rejects.toMatchObject({ code: 'version_conflict' });
    const done = await complete(draft.id, draft.version);
    expect(done).toMatchObject({
      status: 'completed',
      bookBalanceAtEnd: '1600.00',
      difference: '0.00',
    });
    expect(done.completedAt).not.toBeNull();
    expect((await kit.cashbook.transactions.get(kit.db, t1.id)).reconciledIn).toBe(draft.id);
    expect((await kit.cashbook.transactions.get(kit.db, t2.id)).reconciledIn).toBeNull();

    // A completed statement cannot change, and its transactions cannot be reversed.
    await expect(importCsv(draft.id)).rejects.toMatchObject({ code: 'reconciliation_not_draft' });
    await expect(
      match(draft.id, [{ lineId: lines[0]?.id as string, transactionId: null }]),
    ).rejects.toMatchObject({
      code: 'reconciliation_not_draft',
    });
    await expect(complete(draft.id, done.version)).rejects.toMatchObject({
      code: 'reconciliation_transition',
    });
    await expect(
      kit.tx((tx) =>
        kit.cashbook.transactions.reverse(t1.id, { reason: 'Mistake' }, kit.actor, tx),
      ),
    ).rejects.toMatchObject({ code: 'reconciled' });

    // The next statement sees the outstanding cheque; a line far from its date is matched by hand.
    const next = await create('1610', { statementFrom: '2026-11-17', statementTo: '2026-11-30' });
    const nextDetail = await importCsv(
      next.id,
      'date,description,debit,credit\n2026-11-20,Cheque cleared,200,',
    );
    expect(nextDetail.candidates.map((c) => c.id)).toEqual([t2.id]);
    expect(nextDetail.suggestions).toEqual([]);
    const matched = await match(next.id, [
      { lineId: nextDetail.lines[0]?.id as string, transactionId: t2.id },
    ]);
    // The interest of the first statement was never booked, so this one differs by 10.
    expect(matched.figures.difference).toBe('10.00');

    // Un-reconciling frees the transaction for a reversal.
    const reopened = await reopen(draft.id);
    expect(reopened).toMatchObject({ status: 'draft', bookBalanceAtEnd: null, difference: null });
    expect((await kit.cashbook.transactions.get(kit.db, t1.id)).reconciledIn).toBeNull();
    await expect(reopen(draft.id)).rejects.toMatchObject({ code: 'reconciliation_transition' });
    expect(await auditCount(kit.db, 'cashbook.reconciliation.reopen')).toBe(1);
    const again = await complete(draft.id, reopened.version);
    expect(again.status).toBe('completed');
  });
});

describe('creating and listing statements', () => {
  it('refuses a reversed period, an inactive account and an unknown account', async () => {
    await expect(
      create('0', { statementFrom: '2026-11-10', statementTo: '2026-11-09' }),
    ).rejects.toMatchObject({ code: 'period_invalid' });
    await expect(create('0', { accountId: uid(952) })).rejects.toMatchObject({
      code: 'account_not_found',
    });
    const idle = await kit.account();
    await kit.tx((tx) =>
      kit.cashbook.accounts.update(
        idle.id,
        { name: idle.name, active: false, version: idle.version },
        kit.actor,
        tx,
      ),
    );
    await expect(create('0', { accountId: idle.id })).rejects.toMatchObject({
      code: 'account_inactive',
    });
  });

  it('lists the statements of one account or of all, newest period first', async () => {
    const other = await kit.account();
    const mine = await create('1', { statementFrom: '2026-12-01', statementTo: '2026-12-31' });
    const theirs = await kit.tx((tx) =>
      kit.cashbook.reconciliation.create(
        {
          accountId: other.id,
          statementFrom: '2026-11-01',
          statementTo: '2026-11-30',
          statementClosingBalance: '0',
        },
        kit.actor,
        tx,
      ),
    );
    const ofBank = await kit.cashbook.reconciliation.list(kit.db, bank.id);
    expect(ofBank[0]?.id).toBe(mine.id);
    expect(ofBank.every((r) => r.accountId === bank.id)).toBe(true);
    const all = await kit.cashbook.reconciliation.list(kit.db, undefined);
    expect(all.map((r) => r.id)).toContain(theirs.id);
  });
});
