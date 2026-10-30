import { NotFoundError } from '@emporium/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  auditCount,
  createWagesKit,
  eventCount,
  type WagesKit,
} from '../test-support.js';

vi.setConfig({ testTimeout: 120_000 });

let kit: WagesKit;
let counter = 0;
/** Teams made by a test; they are retired afterwards so later months have fewer teams to scan. */
let teams: string[] = [];

beforeAll(async () => {
  kit = await createWagesKit();
  await kit.setSetting('backdating_days', 365);
}, 120_000);
afterAll(() => kit.close());
afterEach(async () => {
  const actor = await kit.actorFor(MANAGEMENT);
  for (const id of teams) {
    const team = await kit.workforce.getTeam(kit.db, id, actor);
    await kit.db.transaction((tx) =>
      kit.workforce.teams.update(id, { active: false }, team.version, actor, tx),
    );
  }
  teams = [];
});

/** A fresh calendar month per test (2026 onward) with the clock on its last day. */
function month() {
  counter += 1;
  const year = 2026 + Math.floor((counter - 1) / 12);
  const m = ((counter - 1) % 12) + 1;
  kit.now.current = new Date(Date.UTC(year, m, 0, 10));
  const text = `${year}-${String(m).padStart(2, '0')}`;
  return { year, month: m, day: (d: number) => `${text}-${String(d).padStart(2, '0')}` };
}

type Worker = { id: string; code: string; fullName: string };
type Status = 'present' | 'half_day' | 'absent' | 'off' | 'leave_paid' | 'leave_unpaid';

/** A project and a team holding the workers. */
async function crew(workers: Worker[]) {
  const projectA = await kit.project();
  const team = await kit.team();
  teams.push(team.id);
  await kit.members(
    team.id,
    workers.map((w) => w.id),
  );
  return { projectA, teamId: team.id };
}

/** One approved sheet: each worker with a status and optional overtime hours. */
async function day(
  setup: { projectA: string; teamId: string },
  date: string,
  entries: [Worker, Status, string?][],
) {
  const input = {
    entries: entries.map(([worker, status, overtime]) => ({
      workerId: worker.id,
      status,
      ...(overtime === undefined ? {} : { overtimeHours: overtime }),
      ...(status === 'present' || status === 'half_day'
        ? { allocations: [{ projectId: setup.projectA, fraction: '1' }] }
        : {}),
    })),
  };
  return kit.approved(
    { ...setup, projectB: setup.projectA, workerA: entries[0]![0], workerB: entries[0]![0] },
    date,
    input,
  );
}

const accountant = () => kit.actorFor(ACCOUNTANT);
const management = () => kit.actorFor(MANAGEMENT);

async function lineOf(periodId: string, worker: Worker) {
  const { lines } = await kit.wages.periods.lines(kit.db, periodId);
  return lines.find((line) => line.workerId === worker.id)!;
}

async function calculate(periodId: string) {
  const actor = await accountant();
  return kit.db.transaction((tx) => kit.wages.periods.calculate(periodId, actor, tx));
}

async function createPeriod(m: { year: number; month: number }) {
  const actor = await accountant();
  return kit.db.transaction((tx) =>
    kit.wages.periods.create({ year: m.year, month: m.month }, actor, tx),
  );
}

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

describe('calculation worked examples (T-1)', () => {
  it('prices daily and salaried workers from approved attendance only', async () => {
    const m = month();
    const daily = await kit.worker();
    const salaried = await kit.worker({ payBasis: 'monthly_salary', amount: '26000' });
    const setup = await crew([daily, salaried]);
    await day(setup, m.day(1), [
      [daily, 'present'],
      [salaried, 'present'],
    ]);
    await day(setup, m.day(2), [
      [daily, 'present'],
      [salaried, 'present'],
    ]);
    await day(setup, m.day(3), [
      [daily, 'half_day'],
      [salaried, 'absent'],
    ]);
    await day(setup, m.day(4), [
      [daily, 'present', '2'],
      [salaried, 'off'],
    ]);
    await day(setup, m.day(5), [
      [daily, 'absent'],
      [salaried, 'present'],
    ]);
    // A draft sheet is not approved attendance and is not counted.
    const extra = await kit.save(setup, m.day(6), {
      entries: [
        {
          workerId: daily.id,
          status: 'present',
          allocations: [{ projectId: setup.projectA, fraction: '1' }],
        },
      ],
    });
    expect(extra.status).toBe('draft');

    const period = await createPeriod(m);
    expect(period).toMatchObject({ status: 'draft', year: m.year, month: m.month });
    const result = await calculate(period.id);

    const d = result.lines.find((l) => l.workerId === daily.id)!;
    expect(d).toMatchObject({
      payBasis: 'daily_rate',
      rate: '1000.00',
      presentDays: '3.00',
      halfDays: '1.00',
      absentDays: '1.00',
      overtimeHours: '2.00',
      basicPay: '3500.00',
      overtimePay: '375.00',
      grossPay: '3875.00',
      netPay: '3875.00',
      roundingAdjustment: '0.00',
    });
    const s = result.lines.find((l) => l.workerId === salaried.id)!;
    expect(s).toMatchObject({
      payBasis: 'monthly_salary',
      presentDays: '3.00',
      offDays: '1.00',
      absentDays: '1.00',
      basicPay: '4000.00',
      netPay: '4000.00',
    });
    expect(result.period.status).toBe('calculated');
    expect(result.totals.netPay).toBe('7875.00');
    const detail = await kit.wages.periods.get(kit.db, period.id);
    expect(detail.lineCount).toBe(2);
    expect(detail.totals.grossPay).toBe('7875.00');
  });

  it('applies a rate change from its effective date (BR-2)', async () => {
    const m = month();
    const worker = await kit.worker();
    const actor = await accountant();
    await kit.db.transaction((tx) =>
      kit.workforce.workers.addRate(
        worker.id,
        { payBasis: 'daily_rate', amount: '1200', effectiveFrom: m.day(3) },
        actor,
        tx,
      ),
    );
    const setup = await crew([worker]);
    for (const d of [1, 2, 3, 4]) await day(setup, m.day(d), [[worker, 'present']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    const line = await lineOf(period.id, worker);
    // Two days at 1,000 and two days at 1,200.
    expect(line.basicPay).toBe('4400.00');
    expect(line.rate).toBe('1200.00');
  });

  it('divides a salary by the basis setting and pays the capped days (T-2)', async () => {
    const m = month();
    const worker = await kit.worker({ payBasis: 'monthly_salary', amount: '30000' });
    const setup = await crew([worker]);
    for (const d of [1, 2, 3]) await day(setup, m.day(d), [[worker, 'present']]);
    await kit.setSetting('workforce.working_days_basis', 30);
    try {
      const period = await createPeriod(m);
      await calculate(period.id);
      expect((await lineOf(period.id, worker)).basicPay).toBe('3000.00');
    } finally {
      await kit.setSetting('workforce.working_days_basis', 26);
    }
  });

  it('refuses to calculate while the working-days basis is not set', async () => {
    const m = month();
    const period = await createPeriod(m);
    await kit.setSetting('workforce.working_days_basis', 0);
    try {
      expect(await codeOf(() => calculate(period.id))).toBe('working_days_basis_not_set');
    } finally {
      await kit.setSetting('workforce.working_days_basis', 26);
    }
  });

  it('pays off days and paid leave to a daily worker only by setting (T-2)', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    await day(setup, m.day(1), [[worker, 'present']]);
    await day(setup, m.day(2), [[worker, 'off']]);
    await day(setup, m.day(3), [[worker, 'leave_paid']]);
    await day(setup, m.day(4), [[worker, 'leave_unpaid']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    const unpaid = await lineOf(period.id, worker);
    expect(unpaid).toMatchObject({
      basicPay: '1000.00',
      offDays: '1.00',
      paidLeaveDays: '1.00',
      absentDays: '1.00',
    });
    await kit.setSetting('wages.pay_off_days_daily', true);
    try {
      await calculate(period.id);
      expect((await lineOf(period.id, worker)).basicPay).toBe('3000.00');
    } finally {
      await kit.setSetting('wages.pay_off_days_daily', false);
    }
  });
});

describe('rounding (T-4)', () => {
  it('rounds net pay to the rupee and keeps the difference, unless the setting is off', async () => {
    const m = month();
    const worker = await kit.worker({ payBasis: 'monthly_salary', amount: '10000' });
    const setup = await crew([worker]);
    for (const d of [1, 2, 3]) await day(setup, m.day(d), [[worker, 'present']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    expect(await lineOf(period.id, worker)).toMatchObject({
      basicPay: '1153.85',
      grossPay: '1153.85',
      netPay: '1154.00',
      roundingAdjustment: '0.15',
    });
    await kit.setSetting('wages.round_net_to_rupee', false);
    try {
      await calculate(period.id);
      expect(await lineOf(period.id, worker)).toMatchObject({
        netPay: '1153.85',
        roundingAdjustment: '0.00',
      });
    } finally {
      await kit.setSetting('wages.round_net_to_rupee', true);
    }
  });
});

describe('advances and deductions (T-3)', () => {
  it('plans the recovery at calculation but moves balances only on approval (AC-3)', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    for (const d of [1, 2, 3, 4, 5]) await day(setup, m.day(d), [[worker, 'present']]);
    const advance = await kit.advance(worker.id, '10000', '2000', '2025-12-15');
    const period = await createPeriod(m);
    await calculate(period.id);
    expect(await lineOf(period.id, worker)).toMatchObject({
      grossPay: '5000.00',
      advanceRecovery: '2000.00',
      netPay: '3000.00',
    });
    expect(await kit.wages.getWorkerAdvanceBalance(kit.db, worker.id)).toBe('10000.00');

    await kit.approvePeriod(period.id);
    expect(await kit.wages.getWorkerAdvanceBalance(kit.db, worker.id)).toBe('8000.00');
    const listed = await kit.wages.advances.list(
      kit.db,
      { workerId: worker.id, limit: 10, offset: 0 },
      await accountant(),
    );
    expect(listed.items[0]).toMatchObject({ id: advance.id, balance: '8000.00', status: 'open' });

    // Reopening reverses the recovery.
    const version = (await kit.wages.periods.get(kit.db, period.id)).version;
    const owner = await management();
    const reopened = await kit.db.transaction((tx) =>
      kit.wages.periods.reopen(period.id, { reason: 'Correct a deduction', version }, owner, tx),
    );
    expect(reopened.status).toBe('reopened');
    expect(await kit.wages.getWorkerAdvanceBalance(kit.db, worker.id)).toBe('10000.00');
  });

  it('closes an advance repaid in full and opens it again on reopening', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    for (const d of [1, 2, 3]) await day(setup, m.day(d), [[worker, 'present']]);
    await kit.advance(worker.id, '1500', '1500', '2025-12-15');
    const period = await createPeriod(m);
    await calculate(period.id);
    expect((await lineOf(period.id, worker)).advanceRecovery).toBe('1500.00');
    await kit.approvePeriod(period.id);
    const closed = await kit.wages.advances.list(
      kit.db,
      { workerId: worker.id, status: 'closed', limit: 10, offset: 0 },
      await accountant(),
    );
    expect(closed.items).toHaveLength(1);
    expect(await kit.wages.getWorkerAdvanceBalance(kit.db, worker.id)).toBe('0.00');
    const version = (await kit.wages.periods.get(kit.db, period.id)).version;
    const actor = await management();
    await kit.db.transaction((tx) =>
      kit.wages.periods.reopen(period.id, { reason: 'Redo', version }, actor, tx),
    );
    const reopenedList = await kit.wages.advances.list(
      kit.db,
      { workerId: worker.id, status: 'open', limit: 10, offset: 0 },
      await accountant(),
    );
    expect(reopenedList.items).toHaveLength(1);
    expect(reopenedList.items[0]!.balance).toBe('1500.00');
  });

  it('reduces the recovery first when deductions leave too little, and flags a shortfall', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    for (const d of [1, 2, 3, 4, 5]) await day(setup, m.day(d), [[worker, 'present']]);
    await kit.advance(worker.id, '10000', '2000', '2025-12-15');
    const period = await createPeriod(m);
    await calculate(period.id);
    const line = await lineOf(period.id, worker);
    const actor = await accountant();
    await kit.db.transaction((tx) =>
      kit.wages.periods.addAdjustment(
        line.id,
        { kind: 'deduction', amount: '4500', reason: 'Tool loss' },
        actor,
        tx,
      ),
    );
    expect(await lineOf(period.id, worker)).toMatchObject({
      deductions: '4500.00',
      advanceRecovery: '500.00',
      netPay: '0.00',
      shortfall: '0.00',
    });
    await kit.db.transaction((tx) =>
      kit.wages.periods.addAdjustment(
        line.id,
        { kind: 'deduction', amount: '1500', reason: 'Damaged scaffold' },
        actor,
        tx,
      ),
    );
    expect(await lineOf(period.id, worker)).toMatchObject({
      deductions: '6000.00',
      advanceRecovery: '0.00',
      netPay: '0.00',
      shortfall: '1000.00',
    });
    const detail = await kit.wages.periods.get(kit.db, period.id);
    expect(detail.warnings.shortfalls).toEqual([
      { workerId: worker.id, workerName: worker.fullName, amount: '1000.00' },
    ]);
    // The shortfall is a warning the submitter acknowledges.
    const submit = (acknowledgeWarnings: boolean) =>
      kit.db.transaction((tx) =>
        kit.wages.periods.submit(
          period.id,
          { version: detail.version, acknowledgeWarnings },
          actor,
          tx,
        ),
      );
    expect(await codeOf(() => submit(false))).toBe('warnings_not_acknowledged');
  });

  it('adds an allowance to the gross pay', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    await day(setup, m.day(1), [[worker, 'present']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    const line = await lineOf(period.id, worker);
    const actor = await accountant();
    const result = await kit.db.transaction((tx) =>
      kit.wages.periods.addAdjustment(
        line.id,
        { kind: 'allowance', amount: '250.50', reason: '  Travel  ' },
        actor,
        tx,
      ),
    );
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0]).toMatchObject({
      kind: 'allowance',
      amount: '250.50',
      reason: 'Travel',
      addedBy: ACCOUNTANT,
    });
    expect(result.lines[0]).toMatchObject({
      allowances: '250.50',
      grossPay: '1250.50',
      netPay: '1251.00',
      roundingAdjustment: '0.50',
    });
    expect(await auditCount(kit.db, 'wages.adjustment.add')).toBeGreaterThan(0);
  });

  it('checks adjustments: amount, reason, line and period state (BR-10)', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    await day(setup, m.day(1), [[worker, 'present']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    const line = await lineOf(period.id, worker);
    const actor = await accountant();
    const add = (input: { kind: 'allowance' | 'deduction'; amount: string; reason: string }) =>
      kit.db.transaction((tx) => kit.wages.periods.addAdjustment(line.id, input, actor, tx));
    expect(await codeOf(() => add({ kind: 'allowance', amount: '0', reason: 'x' }))).toBe(
      'adjustment_amount_invalid',
    );
    expect(await codeOf(() => add({ kind: 'allowance', amount: '5', reason: '  ' }))).toBe(
      'reason_required',
    );
    expect(
      await codeOf(() =>
        kit.db.transaction((tx) =>
          kit.wages.periods.addAdjustment(
            '018f7c7c-ffff-7000-8000-000000000999',
            { kind: 'allowance', amount: '5', reason: 'x' },
            actor,
            tx,
          ),
        ),
      ),
    ).toBe('line_not_found');
    await kit.approvePeriod(period.id);
    expect(await codeOf(() => add({ kind: 'allowance', amount: '5', reason: 'late' }))).toBe(
      'period_not_adjustable',
    );
  });
});

describe('recalculation (T-5)', () => {
  it('is idempotent, keeps manual adjustments and refuses an approved period', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    for (const d of [1, 2]) await day(setup, m.day(d), [[worker, 'present']]);
    const period = await createPeriod(m);
    const first = await calculate(period.id);
    const second = await calculate(period.id);
    expect(second.lines).toEqual(first.lines);
    expect(second.totals).toEqual(first.totals);

    const actor = await accountant();
    await kit.db.transaction((tx) =>
      kit.wages.periods.addAdjustment(
        first.lines[0]!.id,
        { kind: 'allowance', amount: '100', reason: 'Bonus' },
        actor,
        tx,
      ),
    );
    const third = await calculate(period.id);
    expect(third.lines[0]).toMatchObject({ id: first.lines[0]!.id, allowances: '100.00' });
    expect(third.adjustments).toHaveLength(1);

    await kit.approvePeriod(period.id);
    expect(await codeOf(() => calculate(period.id))).toBe('period_approved');
  });

  it('refuses to calculate a period that is with the approver', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    await day(setup, m.day(1), [[worker, 'present']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    const actor = await accountant();
    const version = (await kit.wages.periods.get(kit.db, period.id)).version;
    await kit.db.transaction((tx) =>
      kit.wages.periods.submit(period.id, { version, acknowledgeWarnings: true }, actor, tx),
    );
    expect(await codeOf(() => calculate(period.id))).toBe('period_submitted');
  });

  it('keeps the line of a worker whose attendance is gone only while it has adjustments', async () => {
    const m = month();
    const kept = await kit.worker();
    const dropped = await kit.worker();
    const setup = await crew([kept, dropped]);
    const sheet = await day(setup, m.day(1), [
      [kept, 'present'],
      [dropped, 'present'],
    ]);
    const period = await createPeriod(m);
    const first = await calculate(period.id);
    expect(first.lines).toHaveLength(2);
    const actor = await accountant();
    await kit.db.transaction((tx) =>
      kit.wages.periods.addAdjustment(
        first.lines.find((l) => l.workerId === kept.id)!.id,
        { kind: 'deduction', amount: '50', reason: 'Fine' },
        actor,
        tx,
      ),
    );
    // Unlocking the sheet takes the attendance of both workers out of the approved days.
    const sheetActor = await kit.actorFor(MANAGEMENT);
    await kit.db.transaction((tx) =>
      kit.attendance.sheets.unlock(sheet.id, { reason: 'Fix' }, sheet.version, sheetActor, tx),
    );
    const again = await calculate(period.id);
    expect(again.lines).toHaveLength(1);
    expect(again.lines[0]).toMatchObject({
      workerId: kept.id,
      basicPay: '0.00',
      presentDays: '0.00',
      deductions: '50.00',
      netPay: '0.00',
      shortfall: '50.00',
    });
  });
});

describe('submission and approval (T-6, AC-2)', () => {
  it('is blocked by an unapproved sheet and asks for acknowledgement of missing sheets', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    await day(setup, m.day(1), [[worker, 'present']]);
    // A submitted sheet nobody has approved yet.
    const pending = await kit.save(setup, m.day(2), {
      entries: [
        {
          workerId: worker.id,
          status: 'present',
          allocations: [{ projectId: setup.projectA, fraction: '1' }],
        },
      ],
    });
    await kit.submit(pending.id);
    const period = await createPeriod(m);
    await calculate(period.id);
    const actor = await accountant();
    const version = (await kit.wages.periods.get(kit.db, period.id)).version;
    const submit = (acknowledgeWarnings: boolean) =>
      kit.db.transaction((tx) =>
        kit.wages.periods.submit(period.id, { version, acknowledgeWarnings }, actor, tx),
      );
    // Blocking even when warnings are acknowledged; the error names the sheet date.
    const blocked = await submit(true).catch((error: Error & { code: string }) => error);
    expect((blocked as { code: string }).code).toBe('unapproved_attendance');
    expect((blocked as Error).message).toContain(m.day(2));
    const detail = await kit.wages.periods.get(kit.db, period.id);
    expect(detail.warnings.unapprovedSheets.map((s) => s.date)).toEqual([m.day(2)]);

    // Once approved, days with no sheet remain as warnings to acknowledge.
    await kit.decide(pending.id, 'approve');
    expect(
      (await kit.wages.periods.get(kit.db, period.id)).warnings.missingSheets.length,
    ).toBeGreaterThan(0);
    expect(await codeOf(() => submit(false))).toBe('warnings_not_acknowledged');
    const submitted = await submit(true);
    expect(submitted.status).toBe('submitted');
    expect(submitted.approval.status).toBe('pending');
    expect(submitted.totalNet).toBe('1000.00');
  });

  it('approves through the engine, locks attendance and emits the event once (AC-2)', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    const sheet = await day(setup, m.day(1), [[worker, 'present']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    const before = await eventCount(kit.db, 'wages.period.approved');
    await kit.approvePeriod(period.id);
    await kit.dispatch();
    const approved = await kit.wages.periods.get(kit.db, period.id);
    expect(approved).toMatchObject({ status: 'approved', approvedBy: MANAGEMENT });
    expect(approved.warnings).toEqual({ unapprovedSheets: [], missingSheets: [], shortfalls: [] });
    expect(await eventCount(kit.db, 'wages.period.approved')).toBe(before + 1);

    // The approved attendance of the month can no longer be unlocked.
    const actor = await kit.actorFor(MANAGEMENT);
    const unlock = () =>
      kit.db.transaction((tx) =>
        kit.attendance.sheets.unlock(sheet.id, { reason: 'Mistake' }, sheet.version, actor, tx),
      );
    expect(await codeOf(unlock)).toBe('wage_period_approved');
    expect(await kit.wages.approvedPeriodOf(kit.db, m.day(1))).toBe(
      `${m.year}-${String(m.month).padStart(2, '0')}`,
    );

    // Reopening makes it possible again.
    const version = approved.version;
    await kit.db.transaction((tx) =>
      kit.wages.periods.reopen(period.id, { reason: 'Mistake found', version }, actor, tx),
    );
    expect(await kit.wages.approvedPeriodOf(kit.db, m.day(1))).toBeNull();
    expect(await codeOf(unlock)).toBe('no error');
  });

  it('sends a rejected, returned or withdrawn period back to calculated and ignores replays', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    await day(setup, m.day(1), [[worker, 'present']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    const actor = await accountant();
    const submit = async () => {
      const version = (await kit.wages.periods.get(kit.db, period.id)).version;
      await kit.db.transaction((tx) =>
        kit.wages.periods.submit(period.id, { version, acknowledgeWarnings: true }, actor, tx),
      );
      return kit.approvals.getApprovalState(kit.db, 'wage_period', period.id);
    };
    for (const action of ['reject', 'return'] as const) {
      const state = await submit();
      if (state.status === 'none') throw new Error('no request');
      await kit.db.transaction((tx) =>
        kit.approvals.service.act(
          state.id,
          action,
          { comment: 'Check the overtime' },
          { userId: MANAGEMENT, roles: ['management'], scopes: [], requestId: null },
          tx,
        ),
      );
      await kit.dispatch();
      const back = await kit.wages.periods.get(kit.db, period.id);
      expect(back.status).toBe('calculated');
      expect(back.approval.lastComment).toBe('Check the overtime');
    }
    // Withdrawn by the requester.
    const state = await submit();
    if (state.status === 'none') throw new Error('no request');
    await kit.db.transaction((tx) =>
      kit.approvals.cancelApproval(
        {
          docType: 'wage_period',
          docId: period.id,
          reason: 'Withdrawn',
          actorUserId: ACCOUNTANT,
        },
        tx,
      ),
    );
    await kit.dispatch();
    expect((await kit.wages.periods.get(kit.db, period.id)).status).toBe('calculated');
    // An outcome arriving for a period that is not submitted changes nothing.
    await kit.db.transaction((tx) =>
      kit.wages.periods.onApprovalOutcome('approved', { docId: period.id }, tx),
    );
    expect((await kit.wages.periods.get(kit.db, period.id)).status).toBe('calculated');
    await kit.db.transaction((tx) =>
      kit.wages.periods.onApprovalOutcome(
        'approved',
        { docId: '018f7c7c-ffff-7000-8000-000000000998' },
        tx,
      ),
    );
  });

  it('checks the period state, version and content on submit (BR-11)', async () => {
    const m = month();
    const actor = await accountant();
    const period = await createPeriod(m);
    const submit = (version: number) =>
      kit.db.transaction((tx) =>
        kit.wages.periods.submit(period.id, { version, acknowledgeWarnings: true }, actor, tx),
      );
    // A draft cannot be submitted.
    expect(await codeOf(() => submit(period.version))).toBe('period_transition');
    // Nothing to approve when no worker had approved attendance.
    await calculate(period.id);
    const version = (await kit.wages.periods.get(kit.db, period.id)).version;
    expect(await codeOf(() => submit(version))).toBe('period_empty');
    expect(await codeOf(() => submit(version + 5))).toBe('version_conflict');
  });
});

describe('submission without warnings', () => {
  it('submits without acknowledgement when no day is missing and nothing is short', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    await day(setup, m.day(1), [[worker, 'present']]);
    // Every other weekday of the month is a site holiday, so no sheet is missing.
    const holidays: string[] = [];
    for (let d = 2; d <= 31; d += 1) {
      const date = new Date(`${m.day(1).slice(0, 8)}${String(d).padStart(2, '0')}T00:00:00Z`);
      if (date.getUTCMonth() + 1 === m.month && date.getUTCDay() % 6 !== 0) {
        holidays.push(m.day(d));
      }
    }
    await kit.setSetting('site_holidays', holidays.join(','));
    try {
      const period = await createPeriod(m);
      await calculate(period.id);
      const actor = await accountant();
      const version = (await kit.wages.periods.get(kit.db, period.id)).version;
      const submitted = await kit.db.transaction((tx) =>
        kit.wages.periods.submit(period.id, { version, acknowledgeWarnings: false }, actor, tx),
      );
      expect(submitted.status).toBe('submitted');
      const rows = await kit.db.query<{ warnings_acknowledged_by: string | null }>(
        'select warnings_acknowledged_by from wag_periods where id = $1',
        [period.id],
      );
      expect(rows[0]?.warnings_acknowledged_by).toBeNull();
    } finally {
      await kit.setSetting('site_holidays', '');
    }
  });
});

describe('reopening (BR-11)', () => {
  it('needs a reason, a matching version, an approved period and no paid line', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    await day(setup, m.day(1), [[worker, 'present']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    const actor = await management();
    const reopen = (reason: string, version: number) =>
      kit.db.transaction((tx) =>
        kit.wages.periods.reopen(period.id, { reason, version }, actor, tx),
      );
    const calculatedVersion = (await kit.wages.periods.get(kit.db, period.id)).version;
    expect(await codeOf(() => reopen('x', calculatedVersion))).toBe('period_transition');
    await kit.approvePeriod(period.id);
    const version = (await kit.wages.periods.get(kit.db, period.id)).version;
    expect(await codeOf(() => reopen('x', version + 1))).toBe('version_conflict');
    expect(await codeOf(() => reopen('   ', version))).toBe('reason_required');
    kit.paid.any = true;
    try {
      expect(await codeOf(() => reopen('Fix', version))).toBe('period_paid');
    } finally {
      kit.paid.any = false;
    }
    const reopened = await reopen('Fix the allowance', version);
    expect(reopened).toMatchObject({ status: 'reopened', reopenReason: 'Fix the allowance' });
    expect(await eventCount(kit.db, 'wages.period.reopened')).toBeGreaterThan(0);
    // A reopened period can be adjusted, recalculated and submitted again.
    const line = await lineOf(period.id, worker);
    const accountantActor = await accountant();
    await kit.db.transaction((tx) =>
      kit.wages.periods.addAdjustment(
        line.id,
        { kind: 'allowance', amount: '10', reason: 'Correction' },
        accountantActor,
        tx,
      ),
    );
    await calculate(period.id);
    await kit.approvePeriod(period.id);
    expect((await kit.wages.periods.get(kit.db, period.id)).status).toBe('approved');
  });
});

describe('periods', () => {
  it('creates one period per month, validates the month and lists with filters', async () => {
    const m = month();
    const created = await createPeriod(m);
    expect(created).toMatchObject({
      from: `${m.year}-${String(m.month).padStart(2, '0')}-01`,
      status: 'draft',
      version: 1,
    });
    expect(await codeOf(() => createPeriod(m))).toBe('period_exists');
    expect(await codeOf(() => createPeriod({ year: 2026, month: 13 }))).toBe(
      'period_month_invalid',
    );
    const list = await kit.wages.periods.list(kit.db, { year: m.year, limit: 50, offset: 0 });
    expect(list.items.map((p) => p.id)).toContain(created.id);
    const drafts = await kit.wages.periods.list(kit.db, {
      status: 'draft',
      limit: 1,
      offset: 0,
    });
    expect(drafts.items).toHaveLength(1);
    expect(drafts.total).toBeGreaterThanOrEqual(1);
    expect(await auditCount(kit.db, 'wages.period.create')).toBeGreaterThan(0);
  });

  it('reports an unknown period as not found', async () => {
    const id = '018f7c7c-ffff-7000-8000-000000000997';
    expect(await codeOf(() => kit.wages.periods.get(kit.db, id))).toBe('period_not_found');
    expect(await codeOf(() => kit.wages.periods.lines(kit.db, id))).toBe('period_not_found');
    expect(await codeOf(() => kit.wages.periods.reconciliation(kit.db, id))).toBe(
      'period_not_found',
    );
    expect(await codeOf(() => calculate(id))).toBe('period_not_found');
  });

  it('reads the approved wage sheet of a month and refuses an unapproved one', async () => {
    const m = month();
    const worker = await kit.worker();
    const setup = await crew([worker]);
    await day(setup, m.day(1), [[worker, 'present']]);
    const period = await createPeriod(m);
    await calculate(period.id);
    const query = { year: m.year, month: m.month };
    expect(await codeOf(() => kit.wages.getApprovedWageSheet(kit.db, query))).toBe(
      'wage_sheet_not_found',
    );
    expect(
      await codeOf(() => kit.wages.getApprovedWageSheet(kit.db, { year: 2099, month: 1 })),
    ).toBe('wage_sheet_not_found');
    await kit.approvePeriod(period.id);
    const sheet = await kit.wages.getApprovedWageSheet(kit.db, query);
    expect(sheet.period.status).toBe('approved');
    expect(sheet.lines).toHaveLength(1);
    expect(sheet.totals.netPay).toBe('1000.00');
  });
});

describe('reconciliation (T-8)', () => {
  it('lists the workers whose gross pay differs from the allocated cost', async () => {
    const m = month();
    const a = await kit.worker();
    const b = await kit.worker();
    const setup = await crew([a, b]);
    await day(setup, m.day(1), [
      [a, 'present', '2'],
      [b, 'present'],
    ]);
    const period = await createPeriod(m);
    const calculated = await calculate(period.id);
    const equal = await kit.wages.periods.reconciliation(kit.db, period.id);
    expect(equal.differences).toEqual([]);
    expect(equal.totals).toEqual({ allocated: '2375.00', gross: '2375.00', difference: '0.00' });

    const actor = await accountant();
    await kit.db.transaction((tx) =>
      kit.wages.periods.addAdjustment(
        calculated.lines.find((l) => l.workerId === b.id)!.id,
        { kind: 'allowance', amount: '300', reason: 'Bonus' },
        actor,
        tx,
      ),
    );
    const result = await kit.wages.periods.reconciliation(kit.db, period.id);
    expect(result.differences).toEqual([
      {
        workerId: b.id,
        workerCode: b.code,
        workerName: b.fullName,
        allocated: '1000.00',
        gross: '1300.00',
        difference: '300.00',
      },
    ]);
    expect(result.totals).toEqual({ allocated: '2375.00', gross: '2675.00', difference: '300.00' });
    expect(result.rows).toHaveLength(2);
  });
});

describe('a month of 50 workers (AC-1)', () => {
  it('matches an independently computed spreadsheet to the paisa', async () => {
    // Its own kit, so the teams of the other tests do not slow the missing-sheet scan down.
    const shared = kit;
    kit = await createWagesKit();
    try {
      await kit.setSetting('backdating_days', 365);
      await fiftyWorkers();
    } finally {
      await kit.close();
      kit = shared;
      teams = [];
    }
  }, 600_000);
});

async function fiftyWorkers() {
  {
    const m = month();
    const workers: Worker[] = [];
    const pay: { daily: boolean; amount: number }[] = [];
    for (let i = 0; i < 50; i += 1) {
      const daily = i % 3 !== 0;
      // Awkward amounts so that rounding matters: 24 rupees steps and odd salaries.
      const amount = daily ? 900 + (i % 7) * 25 : 31_000 + i * 137;
      workers.push(
        await kit.worker(
          daily
            ? { payBasis: 'daily_rate', amount: String(amount) }
            : { payBasis: 'monthly_salary', amount: String(amount) },
        ),
      );
      pay.push({ daily, amount });
    }
    const setup = await crew(workers);
    const statusFor = (worker: number, date: number): Status => {
      const k = (worker * 7 + date * 3) % 10;
      if (k < 6) return 'present';
      if (k === 6) return 'half_day';
      if (k === 7) return 'off';
      if (k === 8) return 'leave_paid';
      return 'absent';
    };
    const overtimeFor = (worker: number, date: number): string | undefined =>
      (worker + date) % 5 === 0 ? '3' : undefined;
    const dates = [1, 2, 3, 4, 5, 8, 9, 10];
    for (const date of dates) {
      await day(
        setup,
        m.day(date),
        workers.map((w, i): [Worker, Status, string?] => {
          const status = statusFor(i, date);
          const overtime =
            status === 'present' || status === 'half_day' ? overtimeFor(i, date) : undefined;
          return overtime === undefined ? [w, status] : [w, status, overtime];
        }),
      );
    }
    const period = await createPeriod(m);
    const result = await calculate(period.id);
    expect(result.lines).toHaveLength(50);

    // Independent computation in integer paisa (half-up), not using the module's code.
    const halfUp = (numerator: bigint, denominator: bigint): bigint =>
      (2n * numerator + denominator) / (2n * denominator);
    let totalNet = 0n;
    workers.forEach((worker, i) => {
      const { daily, amount } = pay[i]!;
      const paisa = BigInt(amount) * 100n;
      let payable = 0n; // half-days counted in halves
      let overtime = 0n; // paisa x 8 x 26 numerator
      for (const date of dates) {
        const status = statusFor(i, date);
        const ot = status === 'present' || status === 'half_day' ? overtimeFor(i, date) : undefined;
        const halves = status === 'present' ? 2n : status === 'half_day' ? 1n : 0n;
        const paidOff = !daily && (status === 'off' || status === 'leave_paid') ? 2n : 0n;
        payable += halves + paidOff;
        if (ot !== undefined) {
          // hours x daily-equivalent / 8 x 1.5; the daily equivalent of a salary is rounded to 4 decimals
          const equivalent = daily ? paisa * 10_000n : halfUp(paisa * 10_000n, 26n);
          overtime += (BigInt(ot) * equivalent * 3n) / 16n;
        }
      }
      // basic in paisa
      const basic = daily ? (payable * paisa) / 2n : halfUp(payable * paisa, 52n);
      const otPaisa = halfUp(overtime, 10_000n);
      const gross = basic + otPaisa;
      const net = halfUp(gross, 100n) * 100n;
      totalNet += net;
      const line = result.lines.find((l) => l.workerId === worker.id)!;
      expect(line.basicPay, worker.code).toBe(toMoney(basic));
      expect(line.grossPay, worker.code).toBe(toMoney(gross));
      expect(line.netPay, worker.code).toBe(toMoney(net));
    });
    expect(result.totals.netPay).toBe(toMoney(totalNet));
  }
}

const toMoney = (paisa: bigint): string => {
  const whole = paisa / 100n;
  const cents = paisa % 100n;
  return `${whole}.${String(cents).padStart(2, '0')}`;
};

describe('collaborators', () => {
  it('names the worker when a pay rate is missing and rethrows other errors', async () => {
    const missing = await createWagesKit({
      workforce: (real) => ({
        workers: real.workers,
        getWorker: real.getWorker,
        getWorkerRate: async () => {
          throw new NotFoundError('rate_not_found', 'No pay rate');
        },
      }),
    });
    const broken = await createWagesKit({
      workforce: (real) => ({
        workers: real.workers,
        getWorker: real.getWorker,
        getWorkerRate: async () => {
          throw new Error('database down');
        },
      }),
    });
    try {
      for (const [name, other] of [
        ['missing', missing],
        ['broken', broken],
      ] as const) {
        await other.setSetting('backdating_days', 365);
        other.now.current = new Date(Date.UTC(2026, 3, 30, 10));
        const worker = await other.worker();
        const projectA = await other.project();
        const team = await other.team();
        await other.members(team.id, [worker.id]);
        await other.approved(
          { projectA, projectB: projectA, teamId: team.id, workerA: worker, workerB: worker },
          '2026-04-06',
          {
            entries: [
              {
                workerId: worker.id,
                status: 'present',
                allocations: [{ projectId: projectA, fraction: '1' }],
              },
            ],
          },
        );
        const actor = await other.actorFor(ACCOUNTANT);
        const period = await other.db.transaction((tx) =>
          other.wages.periods.create({ year: 2026, month: 4 }, actor, tx),
        );
        const code = await codeOf(() =>
          other.db.transaction((tx) => other.wages.periods.calculate(period.id, actor, tx)),
        );
        // The other error has no code: it is rethrown untouched.
        expect(code, name).toBe(name === 'missing' ? 'worker_rate_missing' : undefined);
      }
    } finally {
      await missing.close();
      await broken.close();
    }
  }, 120_000);

  it('reads every page of workers', async () => {
    const paged = await createWagesKit({
      workforce: (real) => ({
        workers: {
          ...real.workers,
          // One worker per page, so the loop has to ask again for the next page.
          list: (db, query, actor) => real.workers.list(db, { ...query, limit: 1 }, actor),
        },
        getWorker: real.getWorker,
        getWorkerRate: real.getWorkerRate,
      }),
    });
    try {
      await paged.setSetting('backdating_days', 365);
      paged.now.current = new Date(Date.UTC(2026, 4, 31, 10));
      const a = await paged.worker();
      const b = await paged.worker();
      const projectA = await paged.project();
      const team = await paged.team();
      await paged.members(team.id, [a.id, b.id]);
      await paged.approved(
        { projectA, projectB: projectA, teamId: team.id, workerA: a, workerB: b },
        '2026-05-04',
      );
      const period = await paged.calculated(2026, 5);
      const lines = await paged.wages.periods.lines(paged.db, period.id);
      expect(lines.lines.map((l) => l.workerId).sort()).toEqual([a.id, b.id].sort());
    } finally {
      await paged.close();
    }
  }, 120_000);
});
