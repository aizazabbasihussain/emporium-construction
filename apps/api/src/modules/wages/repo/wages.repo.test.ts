import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWagesKit, uid, type WagesKit } from '../test-support.js';
import {
  countAdjustmentsOfLine,
  deleteLines,
  deleteRecoveriesOfLine,
  deleteRecoveriesOfPeriod,
  findAdvance,
  findApprovedPeriodOfDate,
  findLine,
  findPeriod,
  findPeriodOfMonth,
  insertAdjustment,
  insertAdvance,
  insertPeriod,
  insertRecovery,
  listAdjustmentsOfPeriod,
  listLines,
  listOpenAdvances,
  listRecoveriesOfPeriod,
  searchAdvances,
  searchPeriods,
  setAdvanceStatus,
  setLineSettlement,
  setRecoveriesApplied,
  sumAdjustments,
  sumAdvanceBalance,
  updatePeriod,
  upsertLine,
  type NewLine,
} from './wages.repo.js';

let kit: WagesKit;
let seq = 100;
const id = () => uid(++seq);
const at = new Date('2026-10-25T10:00:00Z');
const by = uid(4);

beforeAll(async () => {
  kit = await createWagesKit();
}, 60_000);
afterAll(() => kit.close());

const newPeriod = (year: number, month: number, status = 'draft') =>
  insertPeriod(kit.db, { id: id(), year, month, status }, by, at);

const lineFor = (periodId: string, workerId: string, over: Partial<NewLine> = {}): NewLine => ({
  id: id(),
  periodId,
  workerId,
  workerCode: 'W-1',
  workerName: 'Synthetic Worker',
  payBasis: 'daily_rate',
  rate: '1000.00',
  presentDays: '3.00',
  halfDays: '1.00',
  paidLeaveDays: '0.00',
  offDays: '0.00',
  absentDays: '0.00',
  overtimeHours: '2.00',
  basicPay: '3500.00',
  overtimePay: '375.00',
  allowances: '0.00',
  deductions: '0.00',
  advanceRecovery: '0.00',
  grossPay: '3875.00',
  netPay: '3875.00',
  roundingAdjustment: '0.00',
  shortfall: '0.00',
  ...over,
});

describe('periods', () => {
  it('inserts, finds, locks and updates with the expected version', async () => {
    const row = await newPeriod(2030, 1);
    expect(row).toMatchObject({
      year: 2030,
      month: 1,
      status: 'draft',
      version: 1,
      total_net: '0.00',
    });
    expect(await findPeriod(kit.db, row.id)).toEqual(row);
    expect(await findPeriod(kit.db, row.id, true)).toEqual(row);
    expect(await findPeriod(kit.db, id())).toBeUndefined();
    expect(await findPeriodOfMonth(kit.db, 2030, 1)).toEqual(row);
    expect(await findPeriodOfMonth(kit.db, 2030, 2)).toBeUndefined();

    const updated = await updatePeriod(kit.db, row.id, 1, { status: 'calculated' }, by, at);
    expect(updated).toMatchObject({ status: 'calculated', version: 2 });
    // A stale version updates nothing.
    expect(await updatePeriod(kit.db, row.id, 1, { status: 'submitted' }, by, at)).toBeUndefined();
  });

  it('refuses a second period for the same month', async () => {
    await newPeriod(2030, 3);
    await expect(newPeriod(2030, 3)).rejects.toThrow();
  });

  it('searches by year and status, newest first, with a total', async () => {
    await newPeriod(2031, 1);
    await newPeriod(2031, 2, 'calculated');
    const all = await searchPeriods(kit.db, { year: 2031, limit: 10, offset: 0 });
    expect(all.rows.map((r) => r.month)).toEqual([2, 1]);
    expect(all.total).toBe(2);
    const calculated = await searchPeriods(kit.db, {
      year: 2031,
      status: 'calculated',
      limit: 10,
      offset: 0,
    });
    expect(calculated.rows.map((r) => r.month)).toEqual([2]);
    const paged = await searchPeriods(kit.db, { year: 2031, limit: 1, offset: 1 });
    expect(paged.rows.map((r) => r.month)).toEqual([1]);
    expect((await searchPeriods(kit.db, { limit: 5, offset: 0 })).rows.length).toBeGreaterThan(0);
  });

  it('finds the approved period that contains a date', async () => {
    const row = await newPeriod(2032, 5, 'approved');
    await newPeriod(2032, 6, 'calculated');
    expect((await findApprovedPeriodOfDate(kit.db, '2032-05-31'))?.id).toBe(row.id);
    expect((await findApprovedPeriodOfDate(kit.db, '2032-05-01'))?.id).toBe(row.id);
    expect(await findApprovedPeriodOfDate(kit.db, '2032-06-10')).toBeUndefined();
    expect(await findApprovedPeriodOfDate(kit.db, '2032-04-30')).toBeUndefined();
  });
});

describe('lines and adjustments', () => {
  it('upserts a line by worker, keeps its id and replaces the calculated values', async () => {
    const period = await newPeriod(2033, 1);
    const worker = id();
    const first = await upsertLine(kit.db, lineFor(period.id, worker));
    expect(first).toMatchObject({
      worker_id: worker,
      basic_pay: '3500.00',
      present_days: '3.00',
      rate: '1000.00',
    });
    const second = await upsertLine(
      kit.db,
      lineFor(period.id, worker, { basicPay: '4000.00', presentDays: '4.00' }),
    );
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ basic_pay: '4000.00', present_days: '4.00' });
    expect(await findLine(kit.db, first.id)).toEqual(second);
    expect(await findLine(kit.db, id())).toBeUndefined();
    expect((await listLines(kit.db, period.id)).map((l) => l.id)).toEqual([first.id]);
  });

  it('lists lines by worker code and deletes them', async () => {
    const period = await newPeriod(2033, 2);
    const a = await upsertLine(kit.db, lineFor(period.id, id(), { workerCode: 'W-B' }));
    const b = await upsertLine(kit.db, lineFor(period.id, id(), { workerCode: 'W-A' }));
    expect((await listLines(kit.db, period.id)).map((l) => l.worker_code)).toEqual(['W-A', 'W-B']);
    await deleteLines(kit.db, [a.id]);
    expect((await listLines(kit.db, period.id)).map((l) => l.id)).toEqual([b.id]);
    await deleteLines(kit.db, []);
  });

  it('stores a settlement and rejects a negative net pay', async () => {
    const period = await newPeriod(2033, 3);
    const line = await upsertLine(kit.db, lineFor(period.id, id()));
    const settled = await setLineSettlement(kit.db, line.id, {
      allowances: '10.00',
      deductions: '20.00',
      advanceRecovery: '30.00',
      grossPay: '3885.00',
      netPay: '3835.00',
      roundingAdjustment: '0.00',
      shortfall: '0.00',
    });
    expect(settled).toMatchObject({ allowances: '10.00', net_pay: '3835.00' });
    await expect(
      setLineSettlement(kit.db, line.id, {
        allowances: '0.00',
        deductions: '0.00',
        advanceRecovery: '0.00',
        grossPay: '0.00',
        netPay: '-1.00',
        roundingAdjustment: '0.00',
        shortfall: '0.00',
      }),
    ).rejects.toThrow();
  });

  it('inserts adjustments, totals them by kind and counts them', async () => {
    const period = await newPeriod(2033, 4);
    const line = await upsertLine(kit.db, lineFor(period.id, id()));
    expect(await sumAdjustments(kit.db, line.id)).toEqual({
      allowances: '0.00',
      deductions: '0.00',
    });
    expect(await countAdjustmentsOfLine(kit.db, line.id)).toBe(0);
    const add = (kind: string, amount: string) =>
      insertAdjustment(kit.db, {
        id: id(),
        lineId: line.id,
        kind,
        amount,
        reason: 'Why',
        addedBy: by,
      });
    const first = await add('allowance', '100.50');
    await add('allowance', '20.00');
    await add('deduction', '5.25');
    expect(first).toMatchObject({
      kind: 'allowance',
      amount: '100.50',
      reason: 'Why',
      added_by: by,
    });
    expect(await sumAdjustments(kit.db, line.id)).toEqual({
      allowances: '120.50',
      deductions: '5.25',
    });
    expect(await countAdjustmentsOfLine(kit.db, line.id)).toBe(3);
    const listed = await listAdjustmentsOfPeriod(kit.db, period.id);
    expect(listed).toHaveLength(3);
    expect(listed[0]).toMatchObject({ line_id: line.id, kind: 'allowance' });
    await expect(
      insertAdjustment(kit.db, {
        id: id(),
        lineId: line.id,
        kind: 'allowance',
        amount: '1',
        reason: '',
        addedBy: by,
      }),
    ).rejects.toThrow();
  });
});

describe('advances and recoveries', () => {
  const advance = (workerId: string, over: Record<string, unknown> = {}) =>
    insertAdvance(
      kit.db,
      {
        id: id(),
        worker_id: workerId,
        amount: '10000',
        issued_on: '2026-01-10',
        monthly_recovery: '2000',
        status: 'open',
        ...over,
      },
      by,
      at,
    );

  it('inserts and finds an advance with its balance', async () => {
    const worker = id();
    const row = await advance(worker, { note: 'Medical' });
    expect(row).toMatchObject({
      worker_id: worker,
      amount: '10000.00',
      issued_on: '2026-01-10',
      monthly_recovery: '2000.00',
      status: 'open',
      note: 'Medical',
      balance: '10000.00',
      version: 1,
    });
    expect(await findAdvance(kit.db, row.id)).toEqual(row);
    expect(await findAdvance(kit.db, id())).toBeUndefined();
  });

  it('searches by worker and status, and lists open advances oldest first up to a date', async () => {
    const worker = id();
    const early = await advance(worker, { issued_on: '2026-01-05' });
    const late = await advance(worker, { issued_on: '2026-03-05' });
    const closed = await advance(worker, { issued_on: '2026-02-05', status: 'closed' });
    const other = await advance(id());

    const mine = await searchAdvances(kit.db, { workerId: worker, limit: 10, offset: 0 });
    expect(mine.rows.map((r) => r.id)).toEqual([late.id, closed.id, early.id]);
    expect(mine.total).toBe(3);
    const open = await searchAdvances(kit.db, {
      workerId: worker,
      status: 'open',
      limit: 1,
      offset: 1,
    });
    expect(open.rows.map((r) => r.id)).toEqual([early.id]);
    expect(open.total).toBe(2);
    expect(
      (await searchAdvances(kit.db, { limit: 500, offset: 0 })).rows.map((r) => r.id),
    ).toContain(other.id);

    expect((await listOpenAdvances(kit.db, '2026-12-31', worker)).map((r) => r.id)).toEqual([
      early.id,
      late.id,
    ]);
    expect((await listOpenAdvances(kit.db, '2026-02-01', worker)).map((r) => r.id)).toEqual([
      early.id,
    ]);
    expect((await listOpenAdvances(kit.db, '2026-12-31')).map((r) => r.id)).toEqual(
      expect.arrayContaining([early.id, late.id, other.id]),
    );
  });

  it('moves a balance only when a recovery is applied and sums the open balances', async () => {
    const worker = id();
    const period = await newPeriod(2034, 1);
    const line = await upsertLine(kit.db, lineFor(period.id, worker));
    const one = await advance(worker);
    const two = await advance(worker, { amount: '500', monthly_recovery: '500' });
    expect(await sumAdvanceBalance(kit.db, worker)).toBe('10500.00');
    await insertRecovery(kit.db, {
      advanceId: one.id,
      periodId: period.id,
      lineId: line.id,
      amount: '2000.00',
    });
    await insertRecovery(kit.db, {
      advanceId: two.id,
      periodId: period.id,
      lineId: line.id,
      amount: '500.00',
    });
    // Planned, not applied: balances are unchanged.
    expect(await sumAdvanceBalance(kit.db, worker)).toBe('10500.00');
    expect((await listRecoveriesOfPeriod(kit.db, period.id)).map((r) => r.applied)).toEqual([
      false,
      false,
    ]);

    await setRecoveriesApplied(kit.db, period.id, true);
    expect(await sumAdvanceBalance(kit.db, worker)).toBe('8000.00');
    expect((await findAdvance(kit.db, two.id))?.balance).toBe('0.00');
    await setAdvanceStatus(kit.db, two.id, 'closed');
    const closed = await findAdvance(kit.db, two.id);
    expect(closed).toMatchObject({ status: 'closed', version: 2 });
    expect(await sumAdvanceBalance(kit.db, worker)).toBe('8000.00');

    await setRecoveriesApplied(kit.db, period.id, false);
    await setAdvanceStatus(kit.db, two.id, 'open');
    expect(await sumAdvanceBalance(kit.db, worker)).toBe('10500.00');
  });

  it('deletes the recoveries of a line or of a period', async () => {
    const worker = id();
    const period = await newPeriod(2034, 2);
    const line = await upsertLine(kit.db, lineFor(period.id, worker));
    const other = await upsertLine(kit.db, lineFor(period.id, id()));
    const a = await advance(worker);
    const b = await advance(other.worker_id);
    await insertRecovery(kit.db, {
      advanceId: a.id,
      periodId: period.id,
      lineId: line.id,
      amount: '1.00',
    });
    await insertRecovery(kit.db, {
      advanceId: b.id,
      periodId: period.id,
      lineId: other.id,
      amount: '2.00',
    });
    await deleteRecoveriesOfLine(kit.db, line.id);
    expect((await listRecoveriesOfPeriod(kit.db, period.id)).map((r) => r.advance_id)).toEqual([
      b.id,
    ]);
    await deleteRecoveriesOfPeriod(kit.db, period.id);
    expect(await listRecoveriesOfPeriod(kit.db, period.id)).toEqual([]);
  });

  it('returns a zero balance for a worker without advances', async () => {
    expect(await sumAdvanceBalance(kit.db, id())).toBe('0.00');
  });

  it('rejects an advance with an instalment or amount of zero', async () => {
    await expect(advance(id(), { amount: '0' })).rejects.toThrow();
    await expect(advance(id(), { monthly_recovery: '0' })).rejects.toThrow();
  });
});
