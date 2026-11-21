import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, eventCount } from '../procurement-kit.js';
import type { PaymentInput } from './payments.service.js';
import { MANAGEMENT, TODAY, createPayablesKit, type PayablesKit } from '../test-support.js';

let kit: PayablesKit;
let account: string;
beforeAll(async () => {
  kit = await createPayablesKit();
  account = await kit.bank();
  await kit.withholdingRule();
}, 180_000);
afterAll(() => kit.close());

const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });
const run = <T>(fn: Parameters<typeof kit.run<T>>[0]) => kit.run(fn);
const pay = (id: string, version: number, actor = kit.pactor) =>
  run((tx) => kit.payables.payments.pay(id, version, actor, tx));
const cancelPayment = (id: string, version: number, reason = 'Wrong account') =>
  run((tx) => kit.payables.payments.cancel(id, { reason, version }, kit.pactor, tx));

/** A posted bill for 100 x 50 (base 5000, tax 500, gross 5500), withholding 100 when `works`. */
async function postedBill(over: { works?: boolean; vendorId?: string; qty?: string } = {}) {
  const received = await kit.receipt({
    ...(over.vendorId === undefined ? {} : { vendorId: over.vendorId }),
    lines: [{ quantity: over.qty ?? '100', rate: '50' }],
  });
  const bill = await kit.postedBill(
    kit.billInput(received, {
      ...(over.works === true ? { nature: 'works' } : {}),
      quantities: [over.qty ?? '100'],
    }),
  );
  return { received, bill, vendorId: received.vendorId };
}

const input = (
  vendorId: string,
  allocations: PaymentInput['allocations'],
  over: Partial<PaymentInput> = {},
): PaymentInput => ({
  vendorPartyId: vendorId,
  paymentDate: TODAY,
  method: 'bank_transfer',
  accountId: account,
  allocations,
  ...over,
});

describe('creating a payment (BR-7)', () => {
  it('allocates one vendor’s bills and works out the cash and the withholding', async () => {
    const { bill, vendorId } = await postedBill({ works: true });
    expect(bill).toMatchObject({
      grossTotal: '5500.00',
      withholdingTotal: '100.00',
      netPayable: '5400.00',
    });
    const audits = await auditCount(kit.db, 'payables.payment.create');
    const payment = await kit.payment(input(vendorId, [{ billId: bill.id, amount: '2750' }]));
    expect(payment).toMatchObject({
      status: 'draft',
      amount: '2700.00',
      withholdingDeducted: '50.00',
      allocations: [{ billId: bill.id, amount: '2750.00', withholding: '50.00' }],
    });
    expect(payment.number).toMatch(/^PV-/);
    expect(await auditCount(kit.db, 'payables.payment.create')).toBe(audits + 1);
    const rest = await kit.payment(input(vendorId, [{ billId: bill.id, amount: '2750' }]));
    expect(rest).toMatchObject({ amount: '2700.00', withholdingDeducted: '50.00' });
  });

  it('refuses allocations that do not add up or exceed what is owed', async () => {
    const { bill, vendorId } = await postedBill();
    const one = [{ billId: bill.id, amount: '100' }];
    await refused(kit.payment(input(vendorId, one, { amount: '99' })), 'allocation_sum_mismatch');
    await refused(
      kit.payment(input(vendorId, [{ billId: bill.id, amount: '5501' }])),
      'over_allocation',
    );
    await refused(
      kit.payment(input(vendorId, [{ billId: bill.id, amount: '0' }])),
      'allocation_invalid',
    );
    await refused(kit.payment(input(vendorId, [...one, ...one])), 'allocation_duplicate');
    await refused(kit.payment(input(vendorId, [])), 'allocation_required');
    const exact = await kit.payment(input(vendorId, one, { amount: '100' }));
    expect(exact.amount).toBe('100.00');
  });

  it('refuses a vendor that is not one, a missing bill, other vendors’ bills and unposted bills', async () => {
    const { bill, vendorId } = await postedBill();
    await refused(
      kit.payment(
        input('018f7c7c-0000-7000-8000-000000000001', [{ billId: bill.id, amount: '1' }]),
      ),
      'vendor_not_found',
    );
    await refused(
      kit.payment(
        input(vendorId, [{ billId: '018f7c7c-0000-7000-8000-000000000002', amount: '1' }]),
      ),
      'bill_not_found',
    );
    await refused(
      kit.payment(input(await kit.vendor(), [{ billId: bill.id, amount: '1' }])),
      'vendor_mismatch',
    );
    const received = await kit.receipt();
    const draft = await run((tx) =>
      kit.payables.bills.create(kit.billInput(received), kit.pactor, tx),
    );
    await refused(
      kit.payment(input(received.vendorId, [{ billId: draft.id, amount: '1' }])),
      'bill_not_payable',
    );
  });

  it('asks for the cheque number and date', async () => {
    const { bill, vendorId } = await postedBill();
    const lines = [{ billId: bill.id, amount: '10' }];
    await refused(
      kit.payment(input(vendorId, lines, { method: 'cheque' })),
      'cheque_details_required',
    );
    await refused(
      kit.payment(
        input(vendorId, lines, { method: 'cheque', chequeNumber: ' ', chequeDate: TODAY }),
      ),
      'cheque_details_required',
    );
    const cheque = await kit.payment(
      input(vendorId, lines, { method: 'cheque', chequeNumber: ' CH-7 ', chequeDate: TODAY }),
    );
    expect(cheque).toMatchObject({ chequeNumber: 'CH-7', chequeDate: TODAY });
  });

  it('does not let drafts take what other drafts already reserved', async () => {
    const { bill, vendorId } = await postedBill();
    await kit.payment(input(vendorId, [{ billId: bill.id, amount: '5000' }]));
    await refused(
      kit.payment(input(vendorId, [{ billId: bill.id, amount: '600' }])),
      'over_allocation',
    );
  });
});

describe('approving and paying (BR-7)', () => {
  it('approves small payments at once and asks the owner above the cash book threshold', async () => {
    const { bill, vendorId } = await postedBill();
    await kit.setThreshold('1000');
    try {
      const small = await kit.payment(input(vendorId, [{ billId: bill.id, amount: '1000' }]));
      const approved = await run((tx) =>
        kit.payables.payments.submit(small.id, small.version, kit.pactor, tx),
      );
      expect(approved).toMatchObject({ status: 'approved', approvalDocId: null });
      await refused(
        run((tx) => kit.payables.payments.submit(small.id, approved.version, kit.pactor, tx)),
        'payment_not_draft',
      );
      const large = await kit.payment(input(vendorId, [{ billId: bill.id, amount: '2000' }]));
      const pending = await run((tx) =>
        kit.payables.payments.submit(large.id, large.version, kit.pactor, tx),
      );
      expect(pending).toMatchObject({ status: 'pending_approval', approvalDocId: large.id });
      await refused(pay(pending.id, pending.version), 'payment_not_approved');
      await kit.decide('payment', large.id, 'approve');
      expect((await kit.payables.payments.get(kit.db, large.id)).status).toBe('approved');
    } finally {
      await kit.setThreshold('0');
    }
  });

  it('pays once into the cash book and moves bills through partly paid to paid (AC-1)', async () => {
    const { bill, vendorId } = await postedBill({ works: true });
    const before = await kit.paidTotal(account);
    const events = await eventCount(kit.db, 'payment.recorded');
    const first = await kit.approvedPayment(input(vendorId, [{ billId: bill.id, amount: '2750' }]));
    expect(first.status).toBe('approved');
    const paid = await pay(first.id, first.version);
    expect(paid).toMatchObject({ status: 'paid', paidOn: TODAY });
    expect(paid.cashbookTxnId).toBeTruthy();
    expect((await kit.bill(bill.id)).status).toBe('partly_paid');
    expect(Number(before) - Number(await kit.paidTotal(account))).toBe(2700);
    expect(await eventCount(kit.db, 'payment.recorded')).toBe(events + 1);
    await refused(pay(paid.id, paid.version), 'payment_not_approved');

    const second = await kit.approvedPayment(
      input(vendorId, [{ billId: bill.id, amount: '2750' }]),
    );
    await pay(second.id, second.version);
    expect((await kit.bill(bill.id)).status).toBe('paid');
    expect(Number(before) - Number(await kit.paidTotal(account))).toBe(5400);
    const balance = await kit.payables.getVendorBalance(kit.db, vendorId, TODAY);
    expect(balance).toMatchObject({
      netPayable: '5400.00',
      withholdingPayable: '100.00',
      payments: '5500.00',
      balance: '0.00',
    });
    expect(await kit.payables.getPaidAmount(kit.db, { type: 'purchase', id: bill.id })).toBe(
      '0.00',
    );
  });

  it('keeps the approver from paying their own approval', async () => {
    const { bill, vendorId } = await postedBill();
    const approved = await kit.approvedPayment(
      input(vendorId, [{ billId: bill.id, amount: '100' }]),
    );
    await refused(
      pay(approved.id, approved.version, { ...kit.pactor, userId: MANAGEMENT }),
      'approver_cannot_pay',
    );
  });

  it('holds a post-dated cheque out of the cash book until its date (BR-7)', async () => {
    const { bill, vendorId } = await postedBill();
    const start = kit.now.current;
    const payment = await kit.approvedPayment(
      input(vendorId, [{ billId: bill.id, amount: '1000' }], {
        method: 'cheque',
        chequeNumber: 'CH-PD',
        chequeDate: '2026-10-30',
      }),
    );
    const before = await kit.paidTotal(account);
    const paid = await pay(payment.id, payment.version);
    expect(paid).toMatchObject({ status: 'paid', cashbookTxnId: null });
    expect(await kit.paidTotal(account)).toBe(before);
    expect(await run((tx) => kit.payables.postDueCheques(tx))).toBe(0);
    try {
      kit.now.current = new Date('2026-10-30T10:00:00Z');
      const audits = await auditCount(kit.db, 'payables.payment.cheque-posted');
      expect(await run((tx) => kit.payables.postDueCheques(tx))).toBe(1);
      expect((await kit.payables.payments.get(kit.db, payment.id)).cashbookTxnId).toBeTruthy();
      expect(await auditCount(kit.db, 'payables.payment.cheque-posted')).toBe(audits + 1);
      expect(await run((tx) => kit.payables.postDueCheques(tx))).toBe(0);
      expect(
        Number(before) -
          Number(await kit.cashbook.getAccountBalance(kit.db, account, '2026-10-30')),
      ).toBe(1000);
    } finally {
      kit.now.current = start;
    }
  });
});

describe('cancelling and certificates', () => {
  it('cancels a draft with a reason', async () => {
    const { bill, vendorId } = await postedBill();
    const draft = await kit.payment(input(vendorId, [{ billId: bill.id, amount: '100' }]));
    await refused(cancelPayment(draft.id, draft.version, ' '), 'reason_required');
    const cancelled = await cancelPayment(draft.id, draft.version);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Wrong account' });
    await refused(cancelPayment(cancelled.id, cancelled.version), 'payment_transition');
  });

  it('withdraws the approval request of a payment that waits for the owner', async () => {
    const { bill, vendorId } = await postedBill();
    const draft = await kit.payment(input(vendorId, [{ billId: bill.id, amount: '100' }]));
    const pending = await run((tx) =>
      kit.payables.payments.submit(draft.id, draft.version, kit.pactor, tx),
    );
    expect(pending.status).toBe('pending_approval');
    const cancelled = await cancelPayment(pending.id, pending.version);
    expect(cancelled.status).toBe('cancelled');
    const state = await kit.approvals.getApprovalState(kit.db, 'payment', pending.id);
    expect(state.status).not.toBe('pending');
  });

  it('reverses a paid payment through the cash book and reopens the bill', async () => {
    const { bill, vendorId } = await postedBill();
    const approved = await kit.approvedPayment(
      input(vendorId, [{ billId: bill.id, amount: '5500' }]),
    );
    const before = await kit.paidTotal(account);
    const paid = await pay(approved.id, approved.version);
    expect((await kit.bill(bill.id)).status).toBe('paid');
    const cancelled = await cancelPayment(paid.id, paid.version);
    expect(cancelled.reversalTxnId).toBeTruthy();
    expect(await kit.paidTotal(account)).toBe(before);
    expect((await kit.bill(bill.id)).status).toBe('posted');
    expect((await kit.payables.getVendorBalance(kit.db, vendorId, TODAY)).balance).toBe('5500.00');
  });

  it('keeps a payment on a reconciled statement', async () => {
    const { bill, vendorId } = await postedBill();
    const approved = await kit.approvedPayment(
      input(vendorId, [{ billId: bill.id, amount: '100' }]),
    );
    const paid = await pay(approved.id, approved.version);
    const reconciliation = '018f7c7c-0000-7000-8000-0000000000ee';
    await kit.db.query(
      `insert into cbk_reconciliations (id, account_id, statement_from, statement_to, statement_closing_balance)
       values ($1, $2, '2026-10-01', '2026-10-31', 0)`,
      [reconciliation, account],
    );
    await kit.db.query('update cbk_transactions set reconciled_in = $1 where id = $2', [
      reconciliation,
      paid.cashbookTxnId,
    ]);
    await refused(cancelPayment(paid.id, paid.version), 'payment_reconciled');
  });

  it('records the withholding certificate number', async () => {
    const { bill, vendorId } = await postedBill({ works: true });
    const draft = await kit.payment(input(vendorId, [{ billId: bill.id, amount: '5500' }]));
    const done = await run((tx) =>
      kit.payables.payments.setCertificate(
        draft.id,
        { certificateNo: ' WHT-9 ', version: draft.version },
        kit.pactor,
        tx,
      ),
    );
    expect(done.withholdingCertificateNo).toBe('WHT-9');
    await refused(
      run((tx) =>
        kit.payables.payments.setCertificate(
          draft.id,
          { certificateNo: ' ', version: done.version },
          kit.pactor,
          tx,
        ),
      ),
      'certificate_no_required',
    );
    await refused(
      run((tx) =>
        kit.payables.payments.setCertificate(
          draft.id,
          { certificateNo: 'X', version: 1 },
          kit.pactor,
          tx,
        ),
      ),
      'version_conflict',
    );
    await refused(
      run((tx) =>
        kit.payables.payments.setCertificate(
          '018f7c7c-0000-7000-8000-000000000003',
          { certificateNo: 'X', version: 1 },
          kit.pactor,
          tx,
        ),
      ),
      'payment_not_found',
    );
  });
});

describe('payment runs (BR-11)', () => {
  it('groups the selected bills by vendor under one approval', async () => {
    const a = await postedBill();
    const b = await postedBill();
    const c = await postedBill({ vendorId: a.vendorId });
    const events = await eventCount(kit.db, 'payables.payment.changed');
    const created = await run((tx) =>
      kit.payables.payments.createRun(
        {
          billIds: [a.bill.id, b.bill.id, c.bill.id],
          paymentDate: TODAY,
          method: 'cheque',
          accountId: account,
          chequeNumbers: ['RUN-1', 'RUN-2'],
          chequeDate: TODAY,
          note: ' monthly ',
        },
        kit.pactor,
        tx,
      ),
    );
    expect(created.total).toBe('16500.00');
    expect(
      created.payments.map((p) => [p.vendorPartyId, p.amount, p.status, p.chequeNumber]),
    ).toEqual([
      [a.vendorId, '11000.00', 'pending_approval', 'RUN-1'],
      [b.vendorId, '5500.00', 'pending_approval', 'RUN-2'],
    ]);
    expect(new Set(created.payments.map((p) => p.approvalDocId))).toEqual(new Set([created.id]));
    expect(await eventCount(kit.db, 'payables.payment.changed')).toBeGreaterThan(events);
    await kit.decide('payment', created.id, 'approve');
    for (const p of created.payments) {
      expect((await kit.payables.payments.get(kit.db, p.id)).status).toBe('approved');
    }
    const first = created.payments[0]!;
    const paid = await pay(first.id, (await kit.payables.payments.get(kit.db, first.id)).version);
    expect(paid.status).toBe('paid');
  });

  it('goes back to draft when the owner rejects the run, and refuses empty or unpayable selections', async () => {
    const a = await postedBill();
    const created = await run((tx) =>
      kit.payables.payments.createRun(
        { billIds: [a.bill.id], paymentDate: TODAY, method: 'cash', accountId: account },
        kit.pactor,
        tx,
      ),
    );
    await kit.decide('payment', created.id, 'reject');
    expect((await kit.payables.payments.get(kit.db, created.payments[0]!.id)).status).toBe('draft');
    await run((tx) =>
      kit.payables.payments.onApprovalOutcome('rejected', { docId: created.id }, tx),
    );
    await refused(
      run((tx) =>
        kit.payables.payments.createRun(
          { billIds: [], paymentDate: TODAY, method: 'cash', accountId: account },
          kit.pactor,
          tx,
        ),
      ),
      'run_empty',
    );
    await refused(
      run((tx) =>
        kit.payables.payments.createRun(
          {
            billIds: ['018f7c7c-0000-7000-8000-000000000004'],
            paymentDate: TODAY,
            method: 'cash',
            accountId: account,
          },
          kit.pactor,
          tx,
        ),
      ),
      'bill_not_found',
    );
  });
});

describe('reading payments', () => {
  it('lists by vendor and status', async () => {
    const { bill, vendorId } = await postedBill();
    const draft = await kit.payment(input(vendorId, [{ billId: bill.id, amount: '100' }]));
    const page = await kit.payables.payments.list(kit.db, {
      vendorPartyId: vendorId,
      status: 'draft',
      limit: 10,
      offset: 0,
    });
    expect(page.items.map((p) => p.id)).toEqual([draft.id]);
    await refused(
      kit.payables.payments.get(kit.db, '018f7c7c-0000-7000-8000-000000000005'),
      'payment_not_found',
    );
  });
});
