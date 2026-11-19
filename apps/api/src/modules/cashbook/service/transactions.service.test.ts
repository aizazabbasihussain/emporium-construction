import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT_TWO,
  MANAGEMENT,
  TODAY,
  auditCount,
  createCashbookKit,
  eventCount,
  uid,
  type CashbookKit,
} from '../test-support.js';

let kit: CashbookKit;
beforeAll(async () => {
  kit = await createCashbookKit();
}, 120_000);
afterAll(() => kit.close());

const receipt = (accountId: string, amount: string, over: Record<string, unknown> = {}) =>
  kit.tx((tx) =>
    kit.cashbook.recordReceipt(
      { accountId, txnDate: TODAY, amount, method: 'cash', ...over },
      kit.actor,
      tx,
    ),
  );

const payment = (accountId: string, amount: string, over: Record<string, unknown> = {}) =>
  kit.tx((tx) =>
    kit.cashbook.recordPayment(
      { accountId, txnDate: TODAY, amount, method: 'cash', ...over },
      kit.actor,
      tx,
    ),
  );

const transfer = (from: string, to: string, amount: string, over: Record<string, unknown> = {}) =>
  kit.tx((tx) =>
    kit.cashbook.recordTransfer(
      { fromAccountId: from, toAccountId: to, txnDate: TODAY, amount, ...over },
      kit.actor,
      tx,
    ),
  );

const reverse = (id: string, reason = 'Entered twice', over: Record<string, unknown> = {}) =>
  kit.tx((tx) => kit.cashbook.transactions.reverse(id, { reason, ...over }, kit.actor, tx));

describe('balances and running balances (T-1, AC-1)', () => {
  it('receipts, payments and a transfer give the right balance on each date', async () => {
    await kit.setting('cashbook.payment_approval_threshold', '999999999');
    const till = await kit.account({ kind: 'cash', openingBalance: '1000.50' });
    const bank = await kit.account({ kind: 'bank' });
    await receipt(till.id, '500', { txnDate: '2026-11-16' });
    await payment(till.id, '200.25', { txnDate: '2026-11-17' });
    await transfer(till.id, bank.id, '300');

    expect(await kit.balance(till.id, '2026-11-15')).toBe('1000.50');
    expect(await kit.balance(till.id, '2026-11-16')).toBe('1500.50');
    expect(await kit.balance(till.id, '2026-11-17')).toBe('1300.25');
    expect(await kit.balance(till.id, TODAY)).toBe('1000.25');
    expect(await kit.balance(bank.id)).toBe('300.00');

    const book = await kit.cashbook.transactions.list(kit.db, {
      accountId: till.id,
      limit: 50,
      offset: 0,
    });
    // Newest first; every line shows the balance after it.
    expect(book.items.map((t) => [t.txnType, t.runningBalance])).toEqual([
      ['transfer_out', '1000.25'],
      ['payment', '1300.25'],
      ['receipt', '1500.50'],
    ]);
    expect(book.total).toBe(3);
  });

  it('numbers transactions in one gapless series and publishes the events', async () => {
    const account = await kit.account();
    const first = await receipt(account.id, '10');
    const second = await receipt(account.id, '20');
    const next = (n: string) => Number(n.split('-').pop());
    expect(next(second.number)).toBe(next(first.number) + 1);
    expect(await eventCount(kit.db, 'cash.receipt.recorded')).toBeGreaterThanOrEqual(2);
    expect(await auditCount(kit.db, 'cashbook.txn.post')).toBeGreaterThanOrEqual(2);
  });

  it('a repeated idempotency key returns the first transaction and posts nothing', async () => {
    const account = await kit.account();
    const first = await receipt(account.id, '75', { idempotencyKey: 'rcpt-1' });
    const again = await receipt(account.id, '75', { idempotencyKey: 'rcpt-1' });
    expect(again.id).toBe(first.id);
    expect(await kit.balance(account.id)).toBe('75.00');
  });

  it('keeps the source document and tags of a receipt', async () => {
    const account = await kit.account({ accountCodeTag: '1010' });
    const party = uid(321);
    const row = await receipt(account.id, '40', {
      counterpartyPartyId: party,
      sourceModule: 'receivables',
      sourceDocType: 'receipt',
      sourceDocId: uid(322),
      reference: 'CHQ-1',
      description: ' Stage 1 ',
    });
    expect(row).toMatchObject({
      counterpartyPartyId: party,
      sourceModule: 'receivables',
      reference: 'CHQ-1',
      description: 'Stage 1',
      accountTag: '1010',
    });
    const tagged = await receipt(account.id, '5', { accountTag: ' 4000 ' });
    expect(tagged.accountTag).toBe('4000');
  });
});

describe('posting rules (BR-1, BR-3, BR-10)', () => {
  it('refuses cash below zero and reports the shortfall (T-2, AC-3)', async () => {
    const till = await kit.account({ kind: 'petty_cash', openingBalance: '100' });
    await kit.setting('cashbook.payment_approval_threshold', '999999999');
    await expect(payment(till.id, '150')).rejects.toMatchObject({
      code: 'insufficient_funds',
      details: { shortfall: '50.00' },
    });
    expect(await kit.balance(till.id)).toBe('100.00');
    await payment(till.id, '100');
    expect(await kit.balance(till.id)).toBe('0.00');
  });

  it('a bank account or wallet may overdraw only when the account allows it (T-2)', async () => {
    await kit.setting('cashbook.payment_approval_threshold', '999999999');
    const plain = await kit.account({ kind: 'bank' });
    await expect(payment(plain.id, '1')).rejects.toMatchObject({ code: 'insufficient_funds' });
    const wallet = await kit.account({ kind: 'wallet' });
    await expect(payment(wallet.id, '1')).rejects.toMatchObject({ code: 'insufficient_funds' });
    const overdraft = await kit.account({ kind: 'bank', allowOverdraft: true });
    await payment(overdraft.id, '250');
    expect(await kit.balance(overdraft.id)).toBe('-250.00');
  });

  it('a backdated payment is checked against every later day', async () => {
    await kit.setting('cashbook.payment_approval_threshold', '999999999');
    const till = await kit.account({ kind: 'cash', openingBalance: '100' });
    await payment(till.id, '80', { txnDate: '2026-11-17' });
    // 100 on the 16th is enough, but the 17th would then end at -60.
    await expect(payment(till.id, '80', { txnDate: '2026-11-16' })).rejects.toMatchObject({
      code: 'insufficient_funds',
      details: { shortfall: '60.00' },
    });
  });

  it('refuses a date before the opening date, an inactive account, a zero amount and an unknown account', async () => {
    const account = await kit.account({ openingDate: '2026-11-17' });
    await expect(receipt(account.id, '5', { txnDate: '2026-11-16' })).rejects.toMatchObject({
      code: 'before_opening_date',
    });
    await expect(receipt(account.id, '0')).rejects.toMatchObject({ code: 'amount_invalid' });
    await expect(receipt(uid(999), '5')).rejects.toMatchObject({ code: 'account_not_found' });
    await kit.tx((tx) =>
      kit.cashbook.accounts.update(
        account.id,
        { name: account.name, active: false, version: account.version },
        kit.actor,
        tx,
      ),
    );
    await expect(receipt(account.id, '5')).rejects.toMatchObject({ code: 'account_inactive' });
  });

  it('follows the kernel date rules: not in the future, within the backdating allowance (BR-10)', async () => {
    const account = await kit.account();
    await expect(receipt(account.id, '5', { txnDate: '2026-11-19' })).rejects.toBeTruthy();
    await expect(receipt(account.id, '5', { txnDate: '2026-11-01' })).rejects.toBeTruthy();
    await receipt(account.id, '5', { txnDate: '2026-11-15' });
  });
});

describe('transfers (BR-4, T-3)', () => {
  it('creates two linked legs of the same amount and date', async () => {
    const from = await kit.account({ openingBalance: '1000' });
    const to = await kit.account();
    const result = await transfer(from.id, to.id, '400', {
      reference: 'TR-1',
      description: 'Top up',
    });
    expect(result.out).toMatchObject({
      txnType: 'transfer_out',
      direction: 'out',
      amount: '400.00',
    });
    expect(result.in).toMatchObject({ txnType: 'transfer_in', direction: 'in', amount: '400.00' });
    expect(result.out.transferPairId).not.toBeNull();
    expect(result.in.transferPairId).toBe(result.out.transferPairId);
    expect(await kit.balance(from.id)).toBe('600.00');
    expect(await kit.balance(to.id)).toBe('400.00');
  });

  it('is atomic: a failing second leg rolls the first one back', async () => {
    const from = await kit.account({ openingBalance: '1000' });
    const later = await kit.account({ openingDate: '2026-11-18' });
    // The destination opens after the transfer date, so only the second leg fails.
    await expect(
      transfer(from.id, later.id, '10', { txnDate: '2026-11-17' }),
    ).rejects.toMatchObject({
      code: 'before_opening_date',
    });
    expect(await kit.balance(from.id)).toBe('1000.00');
    const rows = await kit.cashbook.transactions.list(kit.db, {
      accountId: from.id,
      limit: 10,
      offset: 0,
    });
    expect(rows.total).toBe(0);
  });

  it('refuses the same account twice and a source that is short', async () => {
    const till = await kit.account({ kind: 'cash', openingBalance: '10' });
    const to = await kit.account();
    await expect(transfer(till.id, till.id, '1')).rejects.toMatchObject({
      code: 'transfer_same_account',
    });
    await expect(transfer(till.id, to.id, '11')).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
  });

  it('a repeated idempotency key posts the pair once and nets to zero across accounts', async () => {
    const from = await kit.account({ openingBalance: '100' });
    const to = await kit.account();
    const first = await transfer(from.id, to.id, '30', {
      idempotencyKey: 'tr-1',
      method: 'cheque',
    });
    const again = await transfer(from.id, to.id, '30', { idempotencyKey: 'tr-1' });
    expect(again.out.id).toBe(first.out.id);
    expect(again.in.id).toBe(first.in.id);
    expect(first.out.method).toBe('cheque');
    const net = Number(await kit.balance(from.id)) + Number(await kit.balance(to.id));
    expect(net).toBe(100);
  });
});

describe('reversals (BR-2, T-4)', () => {
  it('posts the opposite entry linked to the original and leaves a visible trail', async () => {
    const account = await kit.account();
    const original = await receipt(account.id, '90', { reference: 'R-9' });
    const [reversal] = await reverse(original.id, 'Wrong account');
    expect(reversal).toMatchObject({
      direction: 'out',
      amount: '90.00',
      txnType: 'receipt',
      reversesId: original.id,
      reference: null,
    });
    expect(reversal?.description).toContain('Wrong account');
    expect(await kit.balance(account.id)).toBe('0.00');
    const shown = await kit.cashbook.transactions.get(kit.db, original.id);
    expect(shown.reversed).toBe(true);
    expect(await eventCount(kit.db, 'cash.transaction.reversed')).toBeGreaterThanOrEqual(1);
  });

  it('refuses a missing reason, a second reversal and the reversal of a reversal', async () => {
    const account = await kit.account();
    const original = await receipt(account.id, '10');
    await expect(reverse(original.id, '  ')).rejects.toMatchObject({ code: 'reason_required' });
    const [reversal] = await reverse(original.id);
    await expect(reverse(original.id)).rejects.toMatchObject({ code: 'already_reversed' });
    await expect(reverse((reversal as { id: string }).id)).rejects.toMatchObject({
      code: 'is_reversal',
    });
    await expect(reverse(uid(998))).rejects.toMatchObject({ code: 'transaction_not_found' });
  });

  it('reversing a receipt cannot take cash below zero', async () => {
    await kit.setting('cashbook.payment_approval_threshold', '999999999');
    const till = await kit.account({ kind: 'cash' });
    const original = await receipt(till.id, '100');
    await payment(till.id, '60');
    await expect(reverse(original.id)).rejects.toMatchObject({
      code: 'insufficient_funds',
      details: { shortfall: '60.00' },
    });
  });

  it('reverses both legs of a transfer together, dated on the given day', async () => {
    const from = await kit.account({ openingBalance: '500' });
    const to = await kit.account();
    const { in: inbound } = await transfer(from.id, to.id, '200', { txnDate: '2026-11-16' });
    const legs = await reverse(inbound.id, 'Cancelled', { txnDate: '2026-11-17' });
    expect(legs).toHaveLength(2);
    expect(new Set(legs.map((l) => l.transferPairId)).size).toBe(1);
    expect(legs.every((l) => l.txnDate === '2026-11-17')).toBe(true);
    expect(await kit.balance(from.id)).toBe('500.00');
    expect(await kit.balance(to.id)).toBe('0.00');
  });

  it('refuses a reversal dated before the original entry', async () => {
    const account = await kit.account();
    const original = await receipt(account.id, '10', { txnDate: '2026-11-17' });
    await expect(reverse(original.id, 'Early', { txnDate: '2026-11-16' })).rejects.toMatchObject({
      code: 'reversal_before_original',
    });
  });

  it('a reversed payment frees the approval it used', async () => {
    await kit.setting('cashbook.payment_approval_threshold', '0');
    const account = await kit.account({ openingBalance: '1000' });
    const approval = await kit.approvedRequest('payment', '100');
    const paid = await payment(account.id, '100', { approvalDocId: approval });
    await expect(payment(account.id, '1', { approvalDocId: approval })).rejects.toMatchObject({
      code: 'approval_amount_exceeded',
    });
    await reverse(paid.id);
    await payment(account.id, '100', { approvalDocId: approval });
  });

  it('the database refuses to change or delete a transaction (append-only)', async () => {
    const account = await kit.account();
    const row = await receipt(account.id, '10');
    await expect(
      kit.db.query('update cbk_transactions set amount = 11 where id = $1', [row.id]),
    ).rejects.toThrow();
    await expect(
      kit.db.query('delete from cbk_transactions where id = $1', [row.id]),
    ).rejects.toThrow();
  });
});

describe('payment approval and separation of duties (BR-5, T-5)', () => {
  it('needs an approved request above the threshold (default: every payment)', async () => {
    const account = await kit.account({ openingBalance: '1000' });
    await kit.setting('cashbook.payment_approval_threshold', '0');
    await expect(payment(account.id, '10')).rejects.toMatchObject({ code: 'approval_required' });
    await expect(payment(account.id, '10', { approvalDocId: uid(777) })).rejects.toMatchObject({
      code: 'approval_not_found',
    });

    const { approvalDocId } = await kit.tx((tx) =>
      kit.cashbook.transactions.requestApproval(
        { docType: 'payment', amount: '10', accountId: account.id, note: 'Cement' },
        kit.actor,
        tx,
      ),
    );
    await expect(payment(account.id, '10', { approvalDocId })).rejects.toMatchObject({
      code: 'approval_not_approved',
    });
    await kit.decide('payment', approvalDocId, 'approve');
    const paid = await payment(account.id, '10', { approvalDocId });
    expect(paid.amount).toBe('10.00');
    await expect(payment(account.id, '5', { approvalDocId })).rejects.toMatchObject({
      code: 'approval_amount_exceeded',
    });
  });

  it('a payment at or under the threshold needs no approval; above it does', async () => {
    const account = await kit.account({ openingBalance: '1000' });
    await kit.setting('cashbook.payment_approval_threshold', '50');
    await payment(account.id, '50');
    await expect(payment(account.id, '50.01')).rejects.toMatchObject({ code: 'approval_required' });
  });

  it('the user who approved a request cannot record the payment', async () => {
    await kit.setting('cashbook.payment_approval_threshold', '0');
    const account = await kit.account({ openingBalance: '1000' });
    const approval = await kit.approvedRequest('payment', '10');
    await expect(
      kit.tx((tx) =>
        kit.cashbook.recordPayment(
          {
            accountId: account.id,
            txnDate: TODAY,
            amount: '10',
            method: 'cash',
            approvalDocId: approval,
          },
          kit.actorFor(MANAGEMENT),
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'approver_cannot_record' });
    // Another accountant may record what the first one asked for.
    await kit.tx((tx) =>
      kit.cashbook.recordPayment(
        {
          accountId: account.id,
          txnDate: TODAY,
          amount: '10',
          method: 'cash',
          approvalDocId: approval,
        },
        kit.actorFor(ACCOUNTANT_TWO),
        tx,
      ),
    );
  });

  it('a bank charge needs no approval', async () => {
    await kit.setting('cashbook.payment_approval_threshold', '0');
    const account = await kit.account({ openingBalance: '100' });
    const charge = await payment(account.id, '2.50', { txnType: 'bank_charge' });
    expect(charge.txnType).toBe('bank_charge');
  });

  it('a manual adjustment needs the owner to approve it (BR-1)', async () => {
    const account = await kit.account({ openingBalance: '100' });
    const adjust = (over: Record<string, unknown>) =>
      kit.tx((tx) =>
        kit.cashbook.transactions.recordAdjustment(
          {
            accountId: account.id,
            txnDate: TODAY,
            direction: 'in',
            amount: '25',
            reason: 'Count',
            ...over,
          },
          kit.actor,
          tx,
        ),
      );
    await expect(adjust({})).rejects.toMatchObject({ code: 'approval_required' });
    await expect(adjust({ reason: ' ' })).rejects.toMatchObject({ code: 'reason_required' });
    const approval = await kit.approvedRequest('cash_adjustment', '25');
    const row = await adjust({ approvalDocId: approval });
    expect(row).toMatchObject({ txnType: 'other', direction: 'in', description: 'Count' });
    expect(await kit.balance(account.id)).toBe('125.00');
    // A payment approval is not an adjustment approval.
    const other = await kit.approvedRequest('payment', '25');
    await expect(adjust({ approvalDocId: other })).rejects.toMatchObject({
      code: 'approval_not_found',
    });
  });
});

describe('tags and reports (BR-7, BR-9)', () => {
  it('lists untagged transactions as the needs-tag report and tags or clears one', async () => {
    const account = await kit.account();
    const open = await receipt(account.id, '15');
    const other = await kit.account({ accountCodeTag: '1020' });
    await receipt(other.id, '15');
    const needs = () =>
      kit.cashbook.transactions.list(kit.db, {
        accountId: account.id,
        needsTag: true,
        limit: 50,
        offset: 0,
      });
    expect((await needs()).items.map((t) => t.id)).toEqual([open.id]);
    const tagged = await kit.tx((tx) =>
      kit.cashbook.transactions.setTag(open.id, ' 4010 ', kit.actor, tx),
    );
    expect(tagged.accountTag).toBe('4010');
    expect((await needs()).total).toBe(0);
    const cleared = await kit.tx((tx) =>
      kit.cashbook.transactions.setTag(open.id, '', kit.actor, tx),
    );
    expect(cleared.accountTag).toBeNull();
    await expect(
      kit.tx((tx) => kit.cashbook.transactions.setTag(open.id, 'x'.repeat(41), kit.actor, tx)),
    ).rejects.toMatchObject({ code: 'tag_invalid' });
    await expect(
      kit.tx((tx) => kit.cashbook.transactions.setTag(uid(997), '1', kit.actor, tx)),
    ).rejects.toMatchObject({ code: 'transaction_not_found' });
  });

  it('filters the cash book by date and pages it', async () => {
    const account = await kit.account();
    await receipt(account.id, '1', { txnDate: '2026-11-15' });
    await receipt(account.id, '2', { txnDate: '2026-11-16' });
    await receipt(account.id, '3', { txnDate: '2026-11-17' });
    const page = await kit.cashbook.transactions.list(kit.db, {
      accountId: account.id,
      from: '2026-11-16',
      to: '2026-11-17',
      limit: 1,
      offset: 1,
    });
    expect(page.total).toBe(2);
    expect(page.items.map((t) => t.amount)).toEqual(['2.00']);
    // The running balance is that of the whole account, not of the filtered page.
    expect(page.items[0]?.runningBalance).toBe('3.00');
    const everything = await kit.cashbook.transactions.list(kit.db, { limit: 500, offset: 0 });
    expect(everything.total).toBeGreaterThan(3);
  });

  it('reports balances per account, cash and bank totals and the movement of the day', async () => {
    const db = await createCashbookKit();
    try {
      const till = await db.account({ kind: 'cash', openingBalance: '100' });
      const bank = await db.account({ kind: 'bank', openingBalance: '1000' });
      const wallet = await db.account({ kind: 'wallet', openingBalance: '50' });
      await db.receive(till.id, '25');
      await db.pay(till.id, '10');
      await db.receive(bank.id, '5', { txnDate: '2026-11-17' });
      const position = await db.cashbook.getCashPosition(db.db, TODAY);
      expect(position).toMatchObject({
        date: TODAY,
        totalCash: '115.00',
        totalBank: '1055.00',
        total: '1170.00',
        movementIn: '25.00',
        movementOut: '10.00',
      });
      expect(position.accounts.map((a) => [a.accountId, a.balance])).toEqual(
        expect.arrayContaining([
          [till.id, '115.00'],
          [bank.id, '1005.00'],
          [wallet.id, '50.00'],
        ]),
      );
      const before = await db.cashbook.getCashPosition(db.db, '2026-11-16');
      expect(before.total).toBe('1150.00');
    } finally {
      await db.close();
    }
  }, 60_000);
});
