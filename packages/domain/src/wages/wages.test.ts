import { describe, expect, it } from 'vitest';
import {
  assertAdjustable,
  assertAdjustmentAmount,
  assertAdvance,
  assertCalculable,
  assertPeriodTransition,
  assertReason,
  assertSubmissionReady,
  assertWageSettings,
  calculateBasicPay,
  money,
  monthBounds,
  payableFraction,
  periodStatuses,
  periodTotals,
  periodTransitions,
  reconcile,
  settleLine,
  sumMoney,
  type DayInput,
  type PeriodStatus,
  type WageSettings,
} from './index.js';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

const settings: WageSettings = {
  workingDaysBasis: 26,
  overtimeMultiplier: '1.5',
  payOffDaysDaily: false,
  roundNetToRupee: true,
};

const daily = (date: string, over: Partial<DayInput> = {}): DayInput => ({
  date,
  status: 'present',
  overtimeHours: '0',
  payBasis: 'daily_rate',
  amount: '1000',
  dailyEquivalent: '1000.0000',
  ...over,
});

const salary = (date: string, over: Partial<DayInput> = {}): DayInput => ({
  date,
  status: 'present',
  overtimeHours: '0',
  payBasis: 'monthly_salary',
  amount: '26000',
  dailyEquivalent: '1000.0000',
  ...over,
});

const dates = (count: number, from = 1): string[] =>
  Array.from({ length: count }, (_, i) => `2026-10-${String(from + i).padStart(2, '0')}`);

describe('period state machine', () => {
  it('allows exactly the listed transitions and refuses every other pair', () => {
    for (const from of periodStatuses) {
      for (const to of periodStatuses) {
        const allowed = periodTransitions[from].includes(to);
        expect(codeOf(() => assertPeriodTransition(from, to))).toBe(
          allowed ? 'no error' : 'period_transition',
        );
      }
    }
  });

  it('refuses to calculate an approved or submitted period and allows the others (BR-8)', () => {
    const allowed: PeriodStatus[] = ['draft', 'calculated', 'reopened'];
    for (const status of allowed) expect(codeOf(() => assertCalculable(status))).toBe('no error');
    expect(codeOf(() => assertCalculable('approved'))).toBe('period_approved');
    expect(codeOf(() => assertCalculable('submitted'))).toBe('period_submitted');
  });

  it('allows adjustments only while calculated or reopened (BR-10)', () => {
    expect(codeOf(() => assertAdjustable('calculated'))).toBe('no error');
    expect(codeOf(() => assertAdjustable('reopened'))).toBe('no error');
    for (const status of ['draft', 'submitted', 'approved'] as const) {
      expect(codeOf(() => assertAdjustable(status))).toBe('period_not_adjustable');
    }
  });
});

describe('month bounds', () => {
  it('gives the first and last day, including February of a leap year', () => {
    expect(monthBounds(2026, 10)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthBounds(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthBounds(2028, 2)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthBounds(2026, 11).to).toBe('2026-11-30');
  });

  it('rejects a year or month out of range', () => {
    expect(codeOf(() => monthBounds(1999, 1))).toBe('period_year_invalid');
    expect(codeOf(() => monthBounds(2026.5, 1))).toBe('period_year_invalid');
    expect(codeOf(() => monthBounds(2026, 0))).toBe('period_month_invalid');
    expect(codeOf(() => monthBounds(2026, 13))).toBe('period_month_invalid');
  });
});

describe('money helpers', () => {
  it('rounds half-up to two decimals and sums exactly', () => {
    expect(money('1.005')).toBe('1.01');
    expect(money('2.675')).toBe('2.68');
    expect(money(0)).toBe('0.00');
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(sumMoney([])).toBe('0.00');
  });
});

describe('settings checks', () => {
  it('accepts valid settings and refuses a missing basis or a bad multiplier', () => {
    expect(codeOf(() => assertWageSettings(settings))).toBe('no error');
    expect(codeOf(() => assertWageSettings({ ...settings, workingDaysBasis: 0 }))).toBe(
      'working_days_basis_not_set',
    );
    expect(codeOf(() => assertWageSettings({ ...settings, workingDaysBasis: 26.5 }))).toBe(
      'working_days_basis_not_set',
    );
    expect(codeOf(() => assertWageSettings({ ...settings, overtimeMultiplier: 'abc' }))).toBe(
      'overtime_multiplier_invalid',
    );
    expect(codeOf(() => assertWageSettings({ ...settings, overtimeMultiplier: '0' }))).toBe(
      'overtime_multiplier_invalid',
    );
  });
});

describe('payable fraction (BR-2, BR-3)', () => {
  it('pays present and half days for everyone and absence for no one', () => {
    for (const basis of ['daily_rate', 'monthly_salary'] as const) {
      expect(payableFraction('present', basis, false).toString()).toBe('1');
      expect(payableFraction('half_day', basis, false).toString()).toBe('0.5');
      expect(payableFraction('absent', basis, true).toString()).toBe('0');
      expect(payableFraction('leave_unpaid', basis, true).toString()).toBe('0');
    }
  });

  it('pays off days and paid leave to salaried workers, and to daily workers only by setting', () => {
    for (const status of ['off', 'leave_paid'] as const) {
      expect(payableFraction(status, 'monthly_salary', false).toString()).toBe('1');
      expect(payableFraction(status, 'daily_rate', false).toString()).toBe('0');
      expect(payableFraction(status, 'daily_rate', true).toString()).toBe('1');
    }
  });
});

describe('basic pay worked examples (T-1)', () => {
  it('pays a daily-rate worker 24 present days and 2 half days at 1,000 as 25,000', () => {
    const days = [
      ...dates(24).map((d) => daily(d)),
      daily('2026-10-25', { status: 'half_day' }),
      daily('2026-10-26', { status: 'half_day' }),
    ];
    const pay = calculateBasicPay(days, settings);
    expect(pay.basicPay).toBe('25000.00');
    expect(pay.presentDays).toBe('24.00');
    expect(pay.halfDays).toBe('2.00');
    expect(pay.payBasis).toBe('daily_rate');
    expect(pay.rate).toBe('1000.00');
  });

  it('pays a salary worker of 26,000 on a basis of 26 with 2 absent days 24,000', () => {
    const days = [
      ...dates(24).map((d) => salary(d)),
      salary('2026-10-25', { status: 'absent' }),
      salary('2026-10-26', { status: 'absent' }),
    ];
    const pay = calculateBasicPay(days, settings);
    expect(pay.basicPay).toBe('24000.00');
    expect(pay.absentDays).toBe('2.00');
    expect(pay.payBasis).toBe('monthly_salary');
  });

  it('counts leave, off days and unpaid leave in their own columns', () => {
    const pay = calculateBasicPay(
      [
        daily('2026-10-01', { status: 'leave_paid' }),
        daily('2026-10-02', { status: 'off' }),
        daily('2026-10-03', { status: 'leave_unpaid' }),
        daily('2026-10-04', { status: 'absent' }),
      ],
      settings,
    );
    expect(pay).toMatchObject({
      paidLeaveDays: '1.00',
      offDays: '1.00',
      absentDays: '2.00',
      basicPay: '0.00',
    });
  });

  it('pays overtime hours x (daily-equivalent / 8) x multiplier', () => {
    // 2 hours at 1,000 / 8 = 125 an hour, x 1.5 = 375.
    const pay = calculateBasicPay([daily('2026-10-01', { overtimeHours: '2' })], settings);
    expect(pay.overtimePay).toBe('375.00');
    expect(pay.overtimeHours).toBe('2.00');
    // Multiplier 2 gives 500, the figure of the attendance spec.
    const doubled = calculateBasicPay([daily('2026-10-01', { overtimeHours: '2' })], {
      ...settings,
      overtimeMultiplier: '2',
    });
    expect(doubled.overtimePay).toBe('500.00');
  });

  it('prices overtime of a salary worker from the daily equivalent', () => {
    const pay = calculateBasicPay(
      [salary('2026-10-01', { overtimeHours: '4', dailyEquivalent: '1153.8462', amount: '30000' })],
      settings,
    );
    // 4 x 1153.8462 / 8 x 1.5 = 865.38465 -> 865.38
    expect(pay.overtimePay).toBe('865.38');
  });

  it('splits a mid-month rate change per day for a daily worker', () => {
    const days = [
      ...dates(10).map((d) => daily(d)),
      ...dates(10, 11).map((d) => daily(d, { amount: '1200', dailyEquivalent: '1200.0000' })),
    ];
    const pay = calculateBasicPay(days, settings);
    expect(pay.basicPay).toBe('22000.00');
    expect(pay.rate).toBe('1200.00');
  });

  it('splits a mid-month salary change proportionally for a monthly worker', () => {
    const days = [
      ...dates(13).map((d) => salary(d)),
      ...dates(13, 14).map((d) => salary(d, { amount: '39000', dailyEquivalent: '1500.0000' })),
    ];
    // 13 days x 26,000 / 26 + 13 days x 39,000 / 26 = 13,000 + 19,500.
    expect(calculateBasicPay(days, settings).basicPay).toBe('32500.00');
  });

  it('handles days given out of order and returns the rate of the last day', () => {
    const pay = calculateBasicPay(
      [daily('2026-10-02', { amount: '1100' }), daily('2026-10-01', { amount: '1000' })],
      settings,
    );
    expect(pay.rate).toBe('1100.00');
    expect(pay.basicPay).toBe('2100.00');
  });
});

describe('basis and caps (T-2)', () => {
  const fullMonth = (count: number) => dates(count).map((d) => salary(d));

  it('divides by 26 or by 30 according to the setting', () => {
    const days = fullMonth(15);
    expect(calculateBasicPay(days, settings).basicPay).toBe('15000.00');
    expect(calculateBasicPay(days, { ...settings, workingDaysBasis: 30 }).basicPay).toBe(
      '13000.00',
    );
  });

  it('caps payable days at the basis, scaling a mid-month change proportionally', () => {
    // 28 present days on a basis of 26 pay the full salary, not 28/26 of it.
    expect(calculateBasicPay(fullMonth(28), settings).basicPay).toBe('26000.00');
    const changed = [
      ...dates(14).map((d) => salary(d)),
      ...dates(14, 15).map((d) => salary(d, { amount: '52000', dailyEquivalent: '2000.0000' })),
    ];
    // Uncapped: 14 x 1,000 + 14 x 2,000 = 42,000; scaled by 26 / 28 = 39,000.
    expect(calculateBasicPay(changed, settings).basicPay).toBe('39000.00');
  });

  it('pays off days and paid leave of a salaried worker, and not of a daily worker by default', () => {
    const salaried = [
      salary('2026-10-01'),
      salary('2026-10-02', { status: 'off' }),
      salary('2026-10-03', { status: 'leave_paid' }),
      salary('2026-10-04', { status: 'half_day' }),
    ];
    expect(calculateBasicPay(salaried, settings).basicPay).toBe('3500.00');
    const dailyDays = [
      daily('2026-10-01'),
      daily('2026-10-02', { status: 'off' }),
      daily('2026-10-03', { status: 'leave_paid' }),
    ];
    expect(calculateBasicPay(dailyDays, settings).basicPay).toBe('1000.00');
    expect(calculateBasicPay(dailyDays, { ...settings, payOffDaysDaily: true }).basicPay).toBe(
      '3000.00',
    );
  });

  it('rounds basic pay half-up once at the end', () => {
    // 1 day of 10,000 / 26 = 384.615384...; 3 days = 1153.846153... -> 1153.85.
    const pay = calculateBasicPay(
      dates(3).map((d) => salary(d, { amount: '10000' })),
      settings,
    );
    expect(pay.basicPay).toBe('1153.85');
  });
});

describe('settlement (T-3, T-4)', () => {
  const base = {
    basicPay: '25000.00',
    overtimePay: '0.00',
    allowances: '0.00',
    deductions: '0.00',
    advances: [],
    roundNetToRupee: false,
  };

  it('adds allowances to the gross and takes deductions from the net', () => {
    const result = settleLine({
      ...base,
      overtimePay: '500.00',
      allowances: '250.00',
      deductions: '100.00',
    });
    expect(result).toMatchObject({
      grossPay: '25750.00',
      deductions: '100.00',
      advanceRecovery: '0.00',
      netPay: '25650.00',
      shortfall: '0.00',
      roundingAdjustment: '0.00',
    });
  });

  it('recovers the least of the instalment, the balance and what is left after deductions', () => {
    const advance = (id: string, monthlyRecovery: string, balance: string) => ({
      id,
      monthlyRecovery,
      balance,
    });
    // Instalment is the limit.
    expect(settleLine({ ...base, advances: [advance('a', '2000', '10000')] }).advanceRecovery).toBe(
      '2000.00',
    );
    // Balance is the limit.
    expect(settleLine({ ...base, advances: [advance('a', '2000', '500')] }).advanceRecovery).toBe(
      '500.00',
    );
    // What is left after deductions is the limit; the recovery gives way, net is not negative.
    const squeezed = settleLine({
      ...base,
      deductions: '24000',
      advances: [advance('a', '5000', '10000')],
    });
    expect(squeezed).toMatchObject({
      advanceRecovery: '1000.00',
      netPay: '0.00',
      shortfall: '0.00',
    });
  });

  it('shares the headroom across several advances oldest first and skips an exhausted one', () => {
    const result = settleLine({
      ...base,
      basicPay: '3000.00',
      advances: [
        { id: 'a', monthlyRecovery: '2000', balance: '2000' },
        { id: 'b', monthlyRecovery: '2000', balance: '5000' },
        { id: 'c', monthlyRecovery: '2000', balance: '5000' },
      ],
    });
    expect(result.recoveries).toEqual([
      { advanceId: 'a', amount: '2000.00' },
      { advanceId: 'b', amount: '1000.00' },
    ]);
    expect(result.advanceRecovery).toBe('3000.00');
    expect(result.netPay).toBe('0.00');
  });

  it('flags deductions above the gross as a shortfall and keeps net at zero', () => {
    const result = settleLine({
      ...base,
      basicPay: '1000.00',
      deductions: '1500.00',
      advances: [{ id: 'a', monthlyRecovery: '500', balance: '500' }],
    });
    expect(result).toMatchObject({
      advanceRecovery: '0.00',
      recoveries: [],
      shortfall: '500.00',
      netPay: '0.00',
    });
  });

  it('rounds net pay to the nearest rupee and keeps the difference', () => {
    const up = settleLine({ ...base, basicPay: '1153.85', roundNetToRupee: true });
    expect(up).toMatchObject({
      netPay: '1154.00',
      roundingAdjustment: '0.15',
      grossPay: '1153.85',
    });
    const down = settleLine({ ...base, basicPay: '1153.40', roundNetToRupee: true });
    expect(down).toMatchObject({ netPay: '1153.00', roundingAdjustment: '-0.40' });
    const half = settleLine({ ...base, basicPay: '1153.50', roundNetToRupee: true });
    expect(half.netPay).toBe('1154.00');
    const exact = settleLine({ ...base, basicPay: '1153.00', roundNetToRupee: true });
    expect(exact.roundingAdjustment).toBe('0.00');
  });
});

describe('period totals', () => {
  it('sums every amount over the lines', () => {
    const line = {
      basicPay: '100.10',
      overtimePay: '10.00',
      allowances: '5.00',
      deductions: '1.00',
      advanceRecovery: '2.00',
      grossPay: '115.10',
      netPay: '112.00',
      roundingAdjustment: '-0.10',
    };
    expect(periodTotals([line, line])).toEqual({
      basicPay: '200.20',
      overtimePay: '20.00',
      allowances: '10.00',
      deductions: '2.00',
      advanceRecovery: '4.00',
      grossPay: '230.20',
      netPay: '224.00',
      roundingAdjustment: '-0.20',
    });
    expect(periodTotals([]).netPay).toBe('0.00');
  });
});

describe('input checks', () => {
  it('accepts an adjustment amount above zero with at most two decimals', () => {
    expect(assertAdjustmentAmount('250')).toBe('250.00');
    expect(assertAdjustmentAmount('250.5')).toBe('250.50');
    for (const bad of ['0', '-5', '1.234', 'abc', '']) {
      expect(codeOf(() => assertAdjustmentAmount(bad))).toBe('adjustment_amount_invalid');
    }
  });

  it('requires a reason', () => {
    expect(assertReason('  Eid bonus ')).toBe('Eid bonus');
    expect(codeOf(() => assertReason('   '))).toBe('reason_required');
  });

  it('checks an advance and its instalment', () => {
    expect(assertAdvance({ amount: '10000', monthlyRecovery: '2500.5' })).toEqual({
      amount: '10000.00',
      monthlyRecovery: '2500.50',
    });
    expect(codeOf(() => assertAdvance({ amount: '0', monthlyRecovery: '1' }))).toBe(
      'advance_amount_invalid',
    );
    expect(codeOf(() => assertAdvance({ amount: 'x', monthlyRecovery: '1' }))).toBe(
      'advance_amount_invalid',
    );
    expect(codeOf(() => assertAdvance({ amount: '100', monthlyRecovery: '0' }))).toBe(
      'advance_recovery_invalid',
    );
    expect(codeOf(() => assertAdvance({ amount: '100', monthlyRecovery: 'x' }))).toBe(
      'advance_recovery_invalid',
    );
    expect(codeOf(() => assertAdvance({ amount: '100', monthlyRecovery: '101' }))).toBe(
      'advance_recovery_invalid',
    );
    expect(codeOf(() => assertAdvance({ amount: '100', monthlyRecovery: '100' }))).toBe('no error');
  });
});

describe('submission check (T-6)', () => {
  const ready = { unapproved: [], missing: [], shortfalls: [], acknowledged: false };

  it('passes when nothing is unapproved, missing or short', () => {
    expect(codeOf(() => assertSubmissionReady(ready))).toBe('no error');
  });

  it('blocks on an unapproved sheet and lists it, even if warnings are acknowledged', () => {
    const run = () =>
      assertSubmissionReady({
        ...ready,
        unapproved: [{ teamId: 't1', date: '2026-10-05' }],
        acknowledged: true,
      });
    expect(codeOf(run)).toBe('unapproved_attendance');
    expect(() => run()).toThrow(/2026-10-05 \(team t1\)/);
  });

  it('asks for acknowledgement of missing sheets and shortfalls and then lets them pass', () => {
    const missing = [{ teamId: 't1', date: '2026-10-06' }];
    expect(codeOf(() => assertSubmissionReady({ ...ready, missing }))).toBe(
      'warnings_not_acknowledged',
    );
    expect(codeOf(() => assertSubmissionReady({ ...ready, shortfalls: ['w1'] }))).toBe(
      'warnings_not_acknowledged',
    );
    expect(codeOf(() => assertSubmissionReady({ ...ready, missing, acknowledged: true }))).toBe(
      'no error',
    );
  });
});

describe('reconciliation (T-8)', () => {
  it('lists the workers whose gross differs from the allocated cost, and totals', () => {
    const result = reconcile(
      new Map([
        ['w1', '25000.00'],
        ['w2', '24000.00'],
        ['w3', '500.00'],
      ]),
      new Map([
        ['w1', '25000.00'],
        ['w2', '24500.50'],
        ['w4', '100.00'],
      ]),
    );
    expect(result.rows.map((row) => row.workerId)).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(result.differences).toEqual([
      { workerId: 'w2', allocated: '24000.00', gross: '24500.50', difference: '500.50' },
      { workerId: 'w3', allocated: '500.00', gross: '0.00', difference: '-500.00' },
      { workerId: 'w4', allocated: '0.00', gross: '100.00', difference: '100.00' },
    ]);
    expect(result.totals).toEqual({
      allocated: '49500.00',
      gross: '49600.50',
      difference: '100.50',
    });
  });

  it('reports no differences when both sides agree', () => {
    const same = new Map([['w1', '10.00']]);
    expect(reconcile(same, same).differences).toEqual([]);
    expect(reconcile(new Map(), new Map()).totals.difference).toBe('0.00');
  });
});
