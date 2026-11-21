import { attendanceSettingKeys } from '@emporium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ACCOUNTANT2,
  MANAGEMENT,
  TODAY,
  auditCount,
  createPayrollKit,
  eventCount,
  type PayrollKit,
} from '../test-support.js';

let kit: PayrollKit;
// A wage period exists once per month, so each test builds its own database.
beforeEach(async () => {
  kit = await createPayrollKit();
}, 180_000);
afterEach(() => kit.close());

const rejects = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code });
};

const sum = (values: string[]) =>
  values.reduce((total, v) => total + Math.round(Number(v) * 100), 0);

describe('creating a run (BR-1)', () => {
  it('copies the net pay of the approved sheet into one line per worker', async () => {
    const month = await kit.month({ allowance: '500' });
    const run = await kit.run(month.periodId);
    expect(run.status).toBe('draft');
    expect(run.lineCount).toBe(2);
    const lines = await kit.payroll.runs.lines(kit.db, run.id);
    expect(sum(lines.map((l) => l.netPay))).toBe(Math.round(Number(run.totalNet) * 100));
    expect(await auditCount(kit.db, 'payroll.run.create')).toBeGreaterThan(0);
    expect((await kit.payroll.runs.get(kit.db, run.id)).id).toBe(run.id);
    expect((await kit.payroll.getPayrollRun(kit.db, month.periodId)).id).toBe(run.id);
    expect((await kit.payroll.runs.list(kit.db, { limit: 10, offset: 0 })).total).toBeGreaterThan(
      0,
    );
  });

  it('allows one run per period and only for an approved period', async () => {
    const month = await kit.month();
    await kit.run(month.periodId);
    await rejects(kit.run(month.periodId), 'run_exists');
    const actor = await kit.actorFor(ACCOUNTANT);
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.runs.create({ periodId: '018f7c7c-0000-7000-8000-000000000001' }, actor, tx),
      ),
      'period_not_found',
    );
  });

  it('refuses a period that is not approved', async () => {
    const accountant = await kit.actorFor(ACCOUNTANT);
    const draft = await kit.db.transaction((tx) =>
      kit.wages.periods.create({ year: 2026, month: 9 }, accountant, tx),
    );
    await rejects(kit.run(draft.id), 'period_not_approved');
  });

  it('gives no line to a worker with nothing to pay', async () => {
    const month = await kit.month();
    kit.tweaks.sheet = (real) => ({
      ...real,
      lines: real.lines.map((line, i) => (i === 0 ? { ...line, netPay: '0.00' } : line)),
    });
    try {
      const run = await kit.run(month.periodId);
      expect(run.lineCount).toBe(1);
    } finally {
      kit.tweaks.sheet = undefined;
    }
  });
});

describe('finalizing (BR-2, BR-3, BR-7)', () => {
  it('posts the labour cost, spreads the difference and numbers the payslips', async () => {
    const month = await kit.month({ allowance: '500', withB: true });
    const before = await kit.totals(month.projectA);
    expect(Number(before.approved)).toBeGreaterThan(0);
    const run = await kit.finalized(month.periodId);
    expect(run.status).toBe('finalized');
    expect(run.cost.difference).toBe('500.00');
    expect(run.cost.adjustments.length).toBeGreaterThan(0);
    const a = await kit.totals(month.projectA);
    const b = await kit.totals(month.projectB);
    expect(a.approved).toBe('0.00');
    expect(b.approved).toBe('0.00');
    expect(sum([a.posted, b.posted])).toBe(Math.round(Number(run.cost.grossPay) * 100));
    const lines = await kit.payroll.runs.lines(kit.db, run.id);
    expect(lines.every((l) => /^PSL-/.test(l.payslipNumber ?? ''))).toBe(true);
    expect(await eventCount(kit.db, 'payroll.finalized')).toBeGreaterThan(0);
    expect(await kit.payroll.hasPaidLines(kit.db, month.periodId)).toBe(true);
    expect((await kit.ledger(month.projectA)).some((e) => e.sourceModule === 'payroll')).toBe(true);
  });

  it('posts the whole difference to overhead under that treatment', async () => {
    const month = await kit.month({ allowance: '700' });
    const before = await kit.overheadTotals();
    const run = await kit.finalized(month.periodId, 'overhead');
    const after = await kit.overheadTotals();
    expect(sum([after.posted]) - sum([before.posted])).toBe(70000);
    expect(run.cost.adjustments).toHaveLength(1);
    expect(run.cost.adjustments[0]?.projectId).toBeNull();
  });

  it('posts no adjustment when the difference is zero', async () => {
    const month = await kit.month();
    const run = await kit.finalized(month.periodId);
    expect(run.cost.difference).toBe('0.00');
    expect(run.cost.adjustments).toEqual([]);
  });

  it('refuses a stale version, a second finalization and a changed sheet', async () => {
    const month = await kit.month();
    const run = await kit.run(month.periodId);
    const actor = await kit.actorFor(ACCOUNTANT);
    await rejects(
      kit.db.transaction((tx) => kit.payroll.runs.finalize(run.id, { version: 99 }, actor, tx)),
      'version_conflict',
    );
    kit.tweaks.sheet = (real) => ({ ...real, totals: { ...real.totals, netPay: '1.00' } });
    try {
      await rejects(
        kit.db.transaction((tx) =>
          kit.payroll.runs.finalize(run.id, { version: run.version }, actor, tx),
        ),
        'wage_sheet_changed',
      );
    } finally {
      kit.tweaks.sheet = undefined;
    }
    const done = await kit.db.transaction((tx) =>
      kit.payroll.runs.finalize(run.id, { version: run.version }, actor, tx),
    );
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.runs.finalize(run.id, { version: done.version }, actor, tx),
      ),
      'run_transition',
    );
  });

  it('refuses when the attendance cost in the ledger differs from the reconciliation', async () => {
    const month = await kit.month();
    const run = await kit.run(month.periodId);
    const actor = await kit.actorFor(ACCOUNTANT);
    kit.tweaks.reconciliation = (real) => ({
      ...real,
      totals: { ...real.totals, allocated: '1.00' },
    });
    try {
      await rejects(
        kit.db.transaction((tx) =>
          kit.payroll.runs.finalize(run.id, { version: run.version }, actor, tx),
        ),
        'attendance_cost_incomplete',
      );
    } finally {
      kit.tweaks.reconciliation = undefined;
    }
  });

  it('refuses when the labour cost code is inactive', async () => {
    const month = await kit.month({ allowance: '100' });
    const run = await kit.run(month.periodId);
    const actor = await kit.actorFor(ACCOUNTANT);
    await kit.setSetting(attendanceSettingKeys.labourCostCode, '999');
    try {
      await rejects(
        kit.db.transaction((tx) =>
          kit.payroll.runs.finalize(run.id, { version: run.version }, actor, tx),
        ),
        'labour_cost_code_invalid',
      );
    } finally {
      await kit.setSetting(attendanceSettingKeys.labourCostCode, '200');
    }
  });
});

describe('reopening (BR-7)', () => {
  it('reverses the cost finalization of an unpaid run and finalizes again', async () => {
    const month = await kit.month({ allowance: '500' });
    const run = await kit.finalized(month.periodId);
    const management = await kit.actorFor(MANAGEMENT);
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.runs.reopen(run.id, { reason: '  ', version: run.version }, management, tx),
      ),
      'reason_required',
    );
    const reopened = await kit.db.transaction((tx) =>
      kit.payroll.runs.reopen(
        run.id,
        { reason: 'Wrong sheet', version: run.version },
        management,
        tx,
      ),
    );
    expect(reopened.status).toBe('draft');
    expect((await kit.totals(month.projectA)).posted).toBe('0.00');
    expect(Number((await kit.totals(month.projectA)).approved)).toBeGreaterThan(0);
    const before = await kit.payroll.runs.lines(kit.db, run.id);
    const again = await kit.db.transaction((tx) =>
      kit.payroll.runs.finalize(
        run.id,
        { version: reopened.version },
        // a different accountant may finalize again
        { ...management, userId: ACCOUNTANT2, roles: ['accountant'] },
        tx,
      ),
    );
    expect(again.status).toBe('finalized');
    const after = await kit.payroll.runs.lines(kit.db, run.id);
    expect(after.map((l) => l.payslipNumber)).toEqual(before.map((l) => l.payslipNumber));
    expect(sum([(await kit.totals(month.projectA)).posted])).toBeGreaterThan(0);
  });

  it('refuses a draft run and a run with a paid line', async () => {
    const month = await kit.month();
    const draft = await kit.run(month.periodId);
    const management = await kit.actorFor(MANAGEMENT);
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.runs.reopen(draft.id, { reason: 'x', version: draft.version }, management, tx),
      ),
      'run_not_reopenable',
    );

    const actorA = await kit.actorFor(ACCOUNTANT);
    const run = await kit.db.transaction((tx) =>
      kit.payroll.runs.finalize(draft.id, { version: draft.version }, actorA, tx),
    );
    const account = await kit.bank();
    const lines = await kit.payroll.runs.lines(kit.db, run.id);
    const approval = await kit.approvedRequest(run.id, [lines[0]?.id as string]);
    const accountant = await kit.actorFor(ACCOUNTANT);
    await kit.db.transaction((tx) =>
      kit.payroll.payments.pay(
        run.id,
        {
          lineIds: [lines[0]?.id as string],
          paymentDate: TODAY,
          method: 'bank_transfer',
          accountId: account,
          approvalDocId: approval,
          version: run.version,
        },
        accountant,
        tx,
      ),
    );
    const current = await kit.payroll.runs.get(kit.db, run.id);
    await rejects(
      kit.db.transaction((tx) =>
        kit.payroll.runs.reopen(run.id, { reason: 'x', version: current.version }, management, tx),
      ),
      'run_not_reopenable',
    );
  });
});
