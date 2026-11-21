import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  TODAY,
  createPayrollKit,
  type PayrollKit,
} from '../test-support.js';

let kit: PayrollKit;
let periodId: string;
let projectA: string;
let projectB: string;
beforeEach(async () => {
  kit = await createPayrollKit();
  const month = await kit.month({ allowance: '500', withB: true });
  periodId = month.periodId;
  projectA = month.projectA;
  projectB = month.projectB;
}, 180_000);
afterEach(() => kit.close());

const cents = (value: string) => Math.round(Number(value) * 100);
const paidFor = (projectId: string, asOf: string) =>
  kit.payroll.getPaidWagesForProject(kit.db, projectId, asOf);

async function payAll(runId: string, accountId: string) {
  const run = await kit.payroll.runs.get(kit.db, runId);
  const approval = await kit.approvedRequest(runId);
  const actor = await kit.actorFor(ACCOUNTANT);
  return kit.db.transaction((tx) =>
    kit.payroll.payments.pay(
      runId,
      {
        paymentDate: TODAY,
        method: 'bank_transfer',
        accountId,
        approvalDocId: approval,
        version: run.version,
      },
      actor,
      tx,
    ),
  );
}

describe('wages paid for a project as of a date (P2-08)', () => {
  it("splits a payment by each project's part of the run's cost, from the payment date on", async () => {
    const run = await kit.finalized(periodId);
    expect(await paidFor(projectA, TODAY)).toBe('0.00');
    await payAll(run.id, await kit.bank('1000000'));
    const a = await paidFor(projectA, TODAY);
    const b = await paidFor(projectB, TODAY);
    expect(cents(a)).toBeGreaterThan(0);
    expect(cents(b)).toBeGreaterThan(0);
    // The shares of the two projects make up the whole payment, to the paisa of rounding.
    expect(Math.abs(cents(a) + cents(b) - cents(run.totalNet))).toBeLessThanOrEqual(2);
    // Another day before the payment sees nothing; later days see the same.
    expect(await paidFor(projectA, '2026-10-24')).toBe('0.00');
    expect(await paidFor(projectA, '2026-12-31')).toBe(a);
    // A project with no cost in the run has no share.
    expect(await paidFor('018f7a7a-bbbb-7000-8000-00000000f00d', TODAY)).toBe('0.00');
    await expect(paidFor(projectA, '2026-13-01')).rejects.toMatchObject({ code: 'invalid_date' });
  });

  it('stops counting a payment on the day it was reversed', async () => {
    const run = await kit.finalized(periodId);
    const payment = await payAll(run.id, await kit.bank('1000000'));
    const paid = await paidFor(projectA, TODAY);
    kit.now.current = new Date('2026-10-28T10:00:00Z');
    const management = await kit.actorFor(MANAGEMENT);
    await kit.db.transaction((tx) =>
      kit.payroll.payments.reverse(
        payment.id,
        { reason: 'Paid the wrong account', version: payment.version },
        management,
        tx,
      ),
    );
    expect(await paidFor(projectA, '2026-10-27')).toBe(paid);
    expect(await paidFor(projectA, '2026-10-28')).toBe('0.00');
    kit.now.current = new Date('2026-10-25T10:00:00Z');
  });
});
