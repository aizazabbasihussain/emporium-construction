import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FRIDAY,
  LOGIN_A,
  LOGIN_B,
  LOGIN_SPARE,
  THURSDAY,
  createPortalKit,
  type PortalKit,
} from '../test-support.js';
import { createSelfService } from './self.service.js';

let kit: PortalKit;
let periodId: string;
beforeAll(async () => {
  kit = await createPortalKit();
  await kit.approveAttendance(FRIDAY);
  await kit.approveAttendance(THURSDAY);
  await kit.advance(kit.workerA.id, '10000', '2000');
  periodId = (await kit.calculate()).id;
  await kit.link(kit.workerA.id, LOGIN_A);
  await kit.link(kit.workerB.id, LOGIN_B);
}, 120_000);
afterAll(() => kit.close());

const self = () => kit.workerPortal.self;
const as = (userId: string) => kit.actorFor(userId);
const errorCode = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('own attendance (BR-3)', () => {
  it('lists only the worker’s own approved days, with no money', async () => {
    const result = await self().attendance(kit.db, await as(LOGIN_A), '2026-10');
    expect(result).toEqual({
      month: '2026-10',
      days: [
        { date: THURSDAY, status: 'present', overtimeHours: '2.00' },
        { date: FRIDAY, status: 'present', overtimeHours: '2.00' },
      ],
    });
    const other = await self().attendance(kit.db, await as(LOGIN_B), '2026-10');
    expect(other.days.map((day) => day.overtimeHours)).toEqual(['0.00', '0.00']);
  });

  it('is empty for a month without approved days and refuses a bad month', async () => {
    expect((await self().attendance(kit.db, await as(LOGIN_A), '2026-09')).days).toEqual([]);
    expect(await errorCode(async () => self().attendance(kit.db, await as(LOGIN_A), 'x'))).toBe(
      'invalid_month',
    );
  });
});

describe('own wages (BR-3, T-3)', () => {
  it('shows nothing while the wage sheet is not approved', async () => {
    expect(await self().wages(kit.db, await as(LOGIN_A), '2026-10')).toEqual({
      month: '2026-10',
      line: null,
    });
    expect(await self().advances(kit.db, await as(LOGIN_A))).toEqual({
      balance: '10000.00',
      recoveries: [],
    });
  });

  it('shows the worker’s own line once approved, and hides it again when reopened', async () => {
    await kit.approvePeriod(periodId);

    const a = await self().wages(kit.db, await as(LOGIN_A), '2026-10');
    expect(a.line).toEqual({
      presentDays: '2.00',
      halfDays: '0.00',
      paidLeaveDays: '0.00',
      offDays: '0.00',
      absentDays: '0.00',
      overtimeHours: '4.00',
      basicPay: '2000.00',
      overtimePay: '750.00',
      allowances: '0.00',
      deductions: '0.00',
      advanceRecovery: '2000.00',
      grossPay: '2750.00',
      netPay: '750.00',
    });
    expect(Object.keys(a.line ?? {})).not.toContain('rate');
    const b = await self().wages(kit.db, await as(LOGIN_B), '2026-10');
    expect(b.line?.netPay).toBe('2000.00');
    expect(b.line?.advanceRecovery).toBe('0.00');

    expect(await self().advances(kit.db, await as(LOGIN_A))).toEqual({
      balance: '8000.00',
      recoveries: [{ month: '2026-10', amount: '2000.00' }],
    });
    expect(await self().advances(kit.db, await as(LOGIN_B))).toEqual({
      balance: '0.00',
      recoveries: [],
    });

    await kit.reopenPeriod(periodId);
    expect((await self().wages(kit.db, await as(LOGIN_A), '2026-10')).line).toBeNull();
    expect((await self().advances(kit.db, await as(LOGIN_A))).recoveries).toEqual([]);
  });

  it('is null for another month with no approved sheet', async () => {
    expect((await self().wages(kit.db, await as(LOGIN_A), '2026-09')).line).toBeNull();
  });
});

describe('failures of the wage lookup', () => {
  it('passes on anything but "no approved sheet"', async () => {
    const broken = createSelfService({
      clock: { now: () => kit.now.current },
      workforce: kit.workforce,
      attendance: kit.attendance,
      wages: {
        getApprovedWageSheet: () => Promise.reject(new Error('database down')),
        getWorkerAdvanceBalance: () => Promise.resolve('0.00'),
      },
    });
    await expect(broken.wages(kit.db, await as(LOGIN_A), '2026-10')).rejects.toThrow(
      'database down',
    );
  });

  it('shows no line when the approved sheet holds none for the worker', async () => {
    const empty = createSelfService({
      clock: { now: () => kit.now.current },
      workforce: kit.workforce,
      attendance: kit.attendance,
      wages: {
        getApprovedWageSheet: () => Promise.resolve({ lines: [] } as never),
        getWorkerAdvanceBalance: () => Promise.resolve('0.00'),
      },
    });
    expect(await empty.wages(kit.db, await as(LOGIN_A), '2026-10')).toEqual({
      month: '2026-10',
      line: null,
    });
  });
});

describe('access rules (BR-2, BR-4)', () => {
  it('refuses a login with no link', async () => {
    const spare = await as(LOGIN_SPARE);
    expect(await errorCode(() => self().advances(kit.db, spare))).toBe('no_worker_link');
    expect(await errorCode(() => self().attendance(kit.db, spare, '2026-10'))).toBe(
      'no_worker_link',
    );
    expect(await errorCode(() => self().wages(kit.db, spare, '2026-10'))).toBe('no_worker_link');
  });

  it('ends access at the end of the left date', async () => {
    const management = await kit.actorFor('018f7a7a-bbbb-7000-8000-000000000002');
    const worker = await kit.workforce.getWorker(kit.db, kit.workerB.id, management);
    await kit.db.transaction((tx) =>
      kit.workforce.workers.deactivate(
        kit.workerB.id,
        { leftOn: '2026-10-24' },
        worker.version,
        management,
        tx,
      ),
    );
    const login = await as(LOGIN_B);

    kit.now.current = new Date('2026-10-24T10:00:00Z');
    expect((await self().advances(kit.db, login)).balance).toBe('0.00');

    kit.now.current = new Date('2026-10-25T10:00:00Z');
    expect(await errorCode(() => self().advances(kit.db, login))).toBe('worker_left');
    expect(await errorCode(() => self().attendance(kit.db, login, '2026-10'))).toBe('worker_left');
    expect(await errorCode(() => self().wages(kit.db, login, '2026-10'))).toBe('worker_left');
  });
});
