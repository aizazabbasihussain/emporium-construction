import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TODAY, createCashbookKit, uid, type CashbookKit } from '../test-support.js';
import {
  findAccountByCode,
  findTxnByKey,
  findTxnsByPair,
  listEntries,
  paidAgainstApproval,
  searchTxns,
} from './cashbook.repo.js';

let kit: CashbookKit;
beforeAll(async () => {
  kit = await createCashbookKit();
}, 120_000);
afterAll(() => kit.close());

describe('cash book repository', () => {
  it('lists the ledger entries of one account as plain dates and amounts', async () => {
    const account = await kit.account({ openingBalance: '5' });
    await kit.receive(account.id, '12.5');
    expect(await listEntries(kit.db, account.id)).toEqual([
      { direction: 'in', amount: '12.50', txnDate: TODAY },
    ]);
    expect(await listEntries(kit.db, uid(940))).toEqual([]);
  });

  it('computes the running balance over the whole account before it filters', async () => {
    const account = await kit.account({ openingBalance: '100' });
    await kit.receive(account.id, '10', { txnDate: '2026-11-16' });
    await kit.receive(account.id, '20', { txnDate: '2026-11-17' });
    const { rows, total } = await searchTxns(kit.db, {
      accountId: account.id,
      from: '2026-11-17',
      to: undefined,
      needsTag: undefined,
      limit: 10,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(rows[0]?.running_balance).toBe('130.00');
  });

  it('finds a transaction by its idempotency key and the legs of a transfer by pair', async () => {
    const from = await kit.account({ openingBalance: '50' });
    const to = await kit.account();
    const { out } = await kit.tx((tx) =>
      kit.cashbook.recordTransfer(
        {
          fromAccountId: from.id,
          toAccountId: to.id,
          txnDate: TODAY,
          amount: '5',
          idempotencyKey: 'repo-1',
        },
        kit.actor,
        tx,
      ),
    );
    expect((await findTxnByKey(kit.db, 'repo-1:out'))?.id).toBe(out.id);
    expect(await findTxnByKey(kit.db, 'nothing')).toBeUndefined();
    const legs = await kit.tx((tx) => findTxnsByPair(tx, out.transferPairId as string));
    expect(legs.map((l) => l.direction)).toEqual(['out', 'in']);
  });

  it('sums what is paid against an approval, leaving out reversed payments', async () => {
    await kit.setting('cashbook.payment_approval_threshold', '0');
    const account = await kit.account({ openingBalance: '100' });
    const approval = await kit.approvedRequest('payment', '60');
    const pay = (amount: string) =>
      kit.tx((tx) =>
        kit.cashbook.recordPayment(
          {
            accountId: account.id,
            txnDate: TODAY,
            amount,
            method: 'cash',
            approvalDocId: approval,
          },
          kit.actor,
          tx,
        ),
      );
    expect(await paidAgainstApproval(kit.db, approval)).toBe('0');
    const first = await pay('10');
    await pay('15');
    expect(await paidAgainstApproval(kit.db, approval)).toBe('25.00');
    await kit.tx((tx) =>
      kit.cashbook.transactions.reverse(first.id, { reason: 'Typo' }, kit.actor, tx),
    );
    expect(await paidAgainstApproval(kit.db, approval)).toBe('15.00');
  });

  it('finds an account by code without regard to letter case', async () => {
    const account = await kit.account({ code: 'Case-Test' });
    expect((await findAccountByCode(kit.db, 'CASE-test'))?.id).toBe(account.id);
    expect(await findAccountByCode(kit.db, 'nothing')).toBeUndefined();
  });
});
