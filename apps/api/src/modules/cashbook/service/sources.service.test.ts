import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCashbookKit, uid, type CashbookKit } from '../test-support.js';

let kit: CashbookKit;
beforeAll(async () => {
  kit = await createCashbookKit();
}, 120_000);
afterAll(() => kit.close());

let n = 0;
const issue = async (amount: string, advanceId = uid(5000 + ++n)) => {
  await kit.tx((tx) =>
    kit.platform.events.publish(
      {
        type: 'advance.issued',
        payload: {
          advanceId,
          number: `ADV-${n}`,
          custodianId: uid(60),
          amount,
          issuedOn: '2026-11-17',
        },
      },
      tx,
    ),
  );
  return { advanceId, summary: await kit.platform.events.dispatchDue(kit.db) };
};

const pendingOf = async (advanceId: string) =>
  (await kit.cashbook.sources.list(kit.db, undefined)).find((p) => p.sourceDocId === advanceId);

describe('advances and posted expenses (BR-6, T-6)', () => {
  it('an advance waits for the accountant when no advance account is configured', async () => {
    const { advanceId } = await issue('300');
    expect(await pendingOf(advanceId)).toMatchObject({
      status: 'pending',
      direction: 'out',
      amount: '300.00',
      txnDate: '2026-11-17',
      sourceModule: 'expenses',
      sourceDocType: 'expense_advance',
      note: null,
      transactionId: null,
    });
  });

  it('the accountant chooses the account; the cash leaves once and the movement is not recorded twice', async () => {
    const till = await kit.account({ kind: 'cash', openingBalance: '1000' });
    const { advanceId } = await issue('300');
    const pending = (await pendingOf(advanceId))!;
    const recorded = await kit.tx((tx) =>
      kit.cashbook.sources.record(pending.id, till.id, kit.actor, tx),
    );
    expect(recorded.status).toBe('recorded');
    expect(await kit.balance(till.id)).toBe('700.00');
    const txn = await kit.cashbook.transactions.get(kit.db, recorded.transactionId as string);
    expect(txn).toMatchObject({
      txnType: 'advance',
      direction: 'out',
      amount: '300.00',
      sourceDocType: 'expense_advance',
      sourceDocId: advanceId,
    });
    await expect(
      kit.tx((tx) => kit.cashbook.sources.record(pending.id, till.id, kit.actor, tx)),
    ).rejects.toMatchObject({ code: 'source_already_recorded' });
    await expect(
      kit.tx((tx) => kit.cashbook.sources.record(uid(953), till.id, kit.actor, tx)),
    ).rejects.toMatchObject({ code: 'pending_source_not_found' });

    // Replaying the same event changes nothing.
    await issue('300', advanceId);
    expect(await kit.balance(till.id)).toBe('700.00');
    expect(
      (await kit.cashbook.sources.list(kit.db, 'recorded')).filter(
        (p) => p.sourceDocId === advanceId,
      ),
    ).toHaveLength(1);
  });

  it('the accountant cannot record an advance the account cannot afford', async () => {
    const till = await kit.account({ kind: 'cash', openingBalance: '10' });
    const { advanceId } = await issue('300');
    const pending = (await pendingOf(advanceId))!;
    await expect(
      kit.tx((tx) => kit.cashbook.sources.record(pending.id, till.id, kit.actor, tx)),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
  });

  it('records the advance at once from the configured account, and a replay is harmless', async () => {
    const till = await kit.account({ kind: 'cash', openingBalance: '1000' });
    await kit.setting('cashbook.advance_account_id', till.id);
    const { advanceId } = await issue('250');
    expect(await kit.balance(till.id)).toBe('750.00');
    expect(await pendingOf(advanceId)).toMatchObject({ status: 'recorded', note: null });
    await issue('250', advanceId);
    expect(await kit.balance(till.id)).toBe('750.00');
  });

  it('leaves the advance pending, with the reason, when the configured account refuses it', async () => {
    const poor = await kit.account({ kind: 'cash', openingBalance: '5' });
    await kit.setting('cashbook.advance_account_id', poor.id);
    const { advanceId, summary } = await issue('250');
    expect(summary.retrying).toBe(0);
    const waiting = await pendingOf(advanceId);
    expect(waiting?.status).toBe('pending');
    expect(waiting?.note).toContain('245.00');
    expect(await kit.balance(poor.id)).toBe('5.00');
    // An account that does not exist is refused the same way.
    await kit.setting('cashbook.advance_account_id', uid(954));
    const missing = await issue('10');
    expect(missing.summary.retrying).toBe(0);
    expect((await pendingOf(missing.advanceId))?.note).toBe('Not found');
  });

  it('retries the event when something other than a business rule fails', async () => {
    await kit.setting('cashbook.advance_account_id', 'not-an-id');
    const { summary } = await issue('10');
    expect(summary.retrying).toBe(1);
    await kit.setting('cashbook.advance_account_id', '');
  });

  it('a posted expense moves no cash', async () => {
    const till = await kit.account({ kind: 'cash', openingBalance: '100' });
    await kit.tx((tx) =>
      kit.platform.events.publish(
        {
          type: 'expense.posted',
          payload: { claimId: uid(70), number: 'EXP-1', claimantId: uid(60), total: '40' },
        },
        tx,
      ),
    );
    await kit.platform.events.dispatchDue(kit.db);
    expect(await kit.balance(till.id)).toBe('100.00');
    const book = await kit.cashbook.transactions.list(kit.db, {
      accountId: till.id,
      limit: 10,
      offset: 0,
    });
    expect(book.total).toBe(0);
  });

  it('lists pending movements by status', async () => {
    const pending = await kit.cashbook.sources.list(kit.db, 'pending');
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((p) => p.status === 'pending')).toBe(true);
  });
});
