import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ACCOUNTANT2,
  MANAGEMENT,
  TODAY,
  eventCount,
  createPayrollKit,
  type PayrollKit,
} from '../test-support.js';

let kit: PayrollKit;
let periodId: string;
let workerA: string;
beforeEach(async () => {
  kit = await createPayrollKit();
  const month = await kit.month({ allowance: '500' });
  periodId = month.periodId;
  workerA = month.workerA.id;
}, 180_000);
afterEach(() => kit.close());

const rejects = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code });
};

const cents = (value: string) => Math.round(Number(value) * 100);

async function pay(
  runId: string,
  over: { lineIds?: string[]; approvalDocId?: string; accountId: string; actor?: string },
) {
  const run = await kit.payroll.runs.get(kit.db, runId);
  const actor = await kit.actorFor(over.actor ?? ACCOUNTANT);
  return kit.db.transaction((tx) =>
    kit.payroll.payments.pay(
      runId,
      {
        lineIds: over.lineIds,
        paymentDate: TODAY,
        method: 'bank_transfer',
        accountId: over.accountId,
        approvalDocId: over.approvalDocId,
        version: run.version,
      },
      actor,
      tx,
    ),
  );
}

describe('paying a run (BR-4, BR-6)', () => {
  it('pays every line in one cash book transaction and moves the balance exactly', async () => {
    const run = await kit.finalized(periodId);
    const account = await kit.bank('1000000');
    const approval = await kit.approvedRequest(run.id);
    const payment = await pay(run.id, { accountId: account, approvalDocId: approval });
    expect(payment.amount).toBe(run.totalNet);
    expect(payment.cashbookTxnIds).toHaveLength(1);
    expect(cents(await kit.balance(account))).toBe(100_000_000 - cents(run.totalNet));
    const after = await kit.payroll.runs.get(kit.db, run.id);
    expect(after.status).toBe('paid');
    expect(after.totalPaid).toBe(run.totalNet);
    expect(after.totalUnpaid).toBe('0.00');
    expect(await eventCount(kit.db, 'payroll.paid')).toBe(1);
    const lines = await kit.payroll.runs.lines(kit.db, run.id);
    expect(lines.every((l) => l.paymentStatus === 'paid' && l.paidOn === TODAY)).toBe(true);
    expect((await kit.payroll.payments.listPayments(kit.db, run.id)).map((p) => p.id)).toEqual([
      payment.id,
    ]);
    expect((await kit.payroll.getUnpaidWages(kit.db)).rows).toEqual([]);
    await rejects(pay(run.id, { accountId: account }), 'run_not_payable');
  });

  it('pays part of a run, then the rest, and reports what is unpaid', async () => {
    const run = await kit.finalized(periodId);
    const account = await kit.bank();
    const lines = await kit.payroll.runs.lines(kit.db, run.id);
    const first = lines[0] as (typeof lines)[number];
    const approval = await kit.approvedRequest(run.id, [first.id]);
    await pay(run.id, { lineIds: [first.id], accountId: account, approvalDocId: approval });
    const part = await kit.payroll.runs.get(kit.db, run.id);
    expect(part.status).toBe('part_paid');
    expect(part.paidLineCount).toBe(1);
    kit.now.current = new Date('2026-10-30T10:00:00Z');
    const unpaid = await kit.payroll.getUnpaidWages(kit.db);
    kit.now.current = new Date('2026-10-25T10:00:00Z');
    expect(unpaid.rows).toHaveLength(1);
    expect(unpaid.rows[0]?.ageDays).toBe(5);
    expect(unpaid.byRun[0]).toMatchObject({ runId: run.id, unpaidCount: 1, oldestAgeDays: 5 });
    expect(unpaid.total).toBe(unpaid.rows[0]?.netPay);
    // a paid line cannot be paid again
    await rejects(
      pay(run.id, { lineIds: [first.id], accountId: account, approvalDocId: approval }),
      'line_not_payable',
    );
    const approval2 = await kit.approvedRequest(run.id);
    await pay(run.id, { accountId: account, approvalDocId: approval2 });
    expect((await kit.payroll.runs.get(kit.db, run.id)).status).toBe('paid');
  });

  it('records one cash book transaction per line when the setting is on', async () => {
    await kit.setSetting('payroll_cash_txn_per_line', true);
    const run = await kit.finalized(periodId);
    const account = await kit.bank();
    const approval = await kit.approvedRequest(run.id);
    const payment = await pay(run.id, { accountId: account, approvalDocId: approval });
    expect(payment.cashbookTxnIds).toHaveLength(2);
    expect(cents(await kit.balance(account))).toBe(100_000_000 - cents(run.totalNet));
  });

  it('needs an approved request above the band, naming this run', async () => {
    const run = await kit.finalized(periodId);
    const account = await kit.bank();
    await rejects(pay(run.id, { accountId: account }), 'approval_required');
    await rejects(
      pay(run.id, { accountId: account, approvalDocId: '018f7c7c-0000-7000-8000-000000000009' }),
      'approval_not_found',
    );
  });

  it('pays without a request while the amount is within the band', async () => {
    await kit.setSetting('cashbook.payment_approval_threshold', '100000000');
    const run = await kit.finalized(periodId);
    const account = await kit.bank();
    const request = await kit.payroll.payments.requestPayment(
      run.id,
      {},
      await kit.actorFor(ACCOUNTANT),
      kit.db,
    );
    expect(request.approvalDocId).toBeNull();
    await pay(run.id, { accountId: account });
    expect((await kit.payroll.runs.get(kit.db, run.id)).status).toBe('paid');
  });

  it('refuses a draft run, a stale version and an empty selection', async () => {
    const run = await kit.run(periodId);
    const account = await kit.bank();
    const accountant = await kit.actorFor(ACCOUNTANT);
    await rejects(
      kit.db.transaction((tx) => kit.payroll.payments.requestPayment(run.id, {}, accountant, tx)),
      'run_not_payable',
    );
    const done = await kit.db.transaction((tx) =>
      kit.payroll.runs.finalize(run.id, { version: run.version }, accountant, tx),
    );
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.payments.pay(
          run.id,
          {
            paymentDate: TODAY,
            method: 'cash',
            accountId: account,
            version: done.version + 5,
          },
          accountant,
          tx,
        ),
      ),
      'version_conflict',
    );
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.payments.pay(
          run.id,
          {
            lineIds: [],
            paymentDate: TODAY,
            method: 'cash',
            accountId: account,
            version: done.version,
          },
          accountant,
          tx,
        ),
      ),
      'no_lines_selected',
    );
  });

  it('does not let the user who finalized approve the payment', async () => {
    const draft = await kit.run(periodId);
    const account = await kit.bank();
    // management finalizes here, and the same user then approves the payment
    const management = await kit.actorFor(MANAGEMENT);
    const finalized = await kit.db.transaction((tx) =>
      kit.payroll.runs.finalize(draft.id, { version: draft.version }, management, tx),
    );
    const other = await kit.actorFor(ACCOUNTANT2);
    const request = await kit.db.transaction((tx) =>
      kit.payroll.payments.requestPayment(finalized.id, {}, other, tx),
    );
    await kit.approvePayment(request.approvalDocId as string, MANAGEMENT);
    await rejects(
      pay(finalized.id, {
        accountId: account,
        approvalDocId: request.approvalDocId as string,
        actor: ACCOUNTANT2,
      }),
      'finalizer_cannot_approve',
    );
  });
});

describe('reversing a payment (BR-5)', () => {
  it('reverses the cash book transaction and makes the lines unpaid again', async () => {
    const run = await kit.finalized(periodId);
    const account = await kit.bank();
    const approval = await kit.approvedRequest(run.id);
    const payment = await pay(run.id, { accountId: account, approvalDocId: approval });
    const management = await kit.actorFor(MANAGEMENT);
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.payments.reverse(
          payment.id,
          { reason: ' ', version: payment.version },
          management,
          tx,
        ),
      ),
      'reason_required',
    );
    const reversed = await kit.db.transaction((tx) =>
      kit.payroll.payments.reverse(
        payment.id,
        { reason: 'Paid the wrong account', version: payment.version },
        management,
        tx,
      ),
    );
    expect(reversed.status).toBe('reversed');
    expect(cents(await kit.balance(account))).toBe(100_000_000);
    const after = await kit.payroll.runs.get(kit.db, run.id);
    expect(after.status).toBe('finalized');
    expect(after.totalPaid).toBe('0.00');
    expect((await kit.payroll.getUnpaidWages(kit.db)).rows).toHaveLength(2);
    expect(await eventCount(kit.db, 'payroll.payment.reversed')).toBe(1);
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.payments.reverse(
          payment.id,
          { reason: 'again', version: reversed.version },
          management,
          tx,
        ),
      ),
      'payment_not_reversible',
    );
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.payments.reverse(payment.id, { reason: 'again', version: 1 }, management, tx),
      ),
      'version_conflict',
    );
  });

  it('refuses an unknown payment or run', async () => {
    const management = await kit.actorFor(MANAGEMENT);
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.payments.reverse(
          '018f7c7c-0000-7000-8000-000000000009',
          { reason: 'x', version: 1 },
          management,
          tx,
        ),
      ),
      'payment_not_found',
    );
    await rejects(
      kit.payroll.payments.listPayments(kit.db, '018f7c7c-0000-7000-8000-000000000009'),
      'run_not_found',
    );
  });
});

describe('payslips (BR-3)', () => {
  it('exist only once the run is finalized', async () => {
    const run = await kit.run(periodId);
    await rejects(kit.payroll.payslips.ofRun(kit.db, run.id), 'run_not_finalized');
    await rejects(
      kit.payroll.payslips.get(kit.db, '018f7c7c-0000-7000-8000-000000000009', null),
      'payslip_not_found',
    );
  });

  it('show only the worker own data, and the rate only to that worker', async () => {
    const run = await kit.finalized(periodId);
    const slips = await kit.payroll.payslips.ofRun(kit.db, run.id);
    expect(slips).toHaveLength(2);
    expect(slips.every((s) => s.rate === null)).toBe(true);
    expect(new Set(slips.map((s) => s.number)).size).toBe(2);
    expect(slips.every((s) => /^PSL-/.test(s.number))).toBe(true);
    const mine = slips.find((s) => s.workerId === workerA);
    expect(Number(mine?.allowances)).toBe(500);
    const own = await kit.payroll.payslips.get(kit.db, mine?.lineId as string, workerA);
    expect(own.rate).toBe('1000.00');
    const other = await kit.payroll.payslips.get(kit.db, mine?.lineId as string, 'someone-else');
    expect(other.rate).toBeNull();
    expect(own.attendance.presentDays).toBe(mine?.presentDays);
    expect(own.netPay).toBe(mine?.netPay);
  });
});
