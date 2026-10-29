import { describe, expect, it } from 'vitest';
import {
  assertCanDeactivate,
  assertRateAmount,
  assertValidPeriod,
  assertWorkerIdentity,
  dailyEquivalent,
  maskLast4,
  periodAt,
  periodsOverlap,
  periodsToCloseAt,
  planPeriodInsert,
  type Period,
} from './index.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

describe('worker identity (BR-1)', () => {
  it('requires a CNIC for permanent and daily workers', () => {
    for (const employmentType of ['permanent', 'daily'] as const) {
      expect(
        codeOf(() => assertWorkerIdentity({ employmentType, cnic: null, contractorPartyId: 'p' })),
      ).toBe('cnic_required');
      expect(
        assertWorkerIdentity({ employmentType, cnic: '3520112345671', contractorPartyId: null }),
      ).toBeUndefined();
    }
  });

  it('lets a contract worker of a contractor omit the CNIC, and nobody else', () => {
    expect(
      assertWorkerIdentity({ employmentType: 'contract', cnic: null, contractorPartyId: 'p' }),
    ).toBeUndefined();
    expect(
      codeOf(() =>
        assertWorkerIdentity({ employmentType: 'contract', cnic: null, contractorPartyId: null }),
      ),
    ).toBe('cnic_required');
    expect(
      assertWorkerIdentity({
        employmentType: 'contract',
        cnic: '3520112345671',
        contractorPartyId: null,
      }),
    ).toBeUndefined();
  });
});

describe('masking (BR-8)', () => {
  it('keeps the last four characters', () => {
    expect(maskLast4('3520112345671')).toBe('*********5671');
    expect(maskLast4('123')).toBe('123');
    expect(maskLast4('')).toBe('');
    expect(maskLast4(null)).toBeNull();
  });
});

describe('periods', () => {
  const p = (id: string, from: string, to: string | null): Period => ({ id, from, to });

  it('validates the dates of a period', () => {
    expect(assertValidPeriod({ from: '2026-01-01', to: null })).toBeUndefined();
    expect(assertValidPeriod({ from: '2026-01-01', to: '2026-01-01' })).toBeUndefined();
    expect(codeOf(() => assertValidPeriod({ from: '2026-01-02', to: '2026-01-01' }))).toBe(
      'period_invalid',
    );
    expect(codeOf(() => assertValidPeriod({ from: '2026-13-01', to: null }))).toBe('invalid_date');
  });

  it('knows when two periods overlap, ends included', () => {
    const a = { from: '2026-01-10', to: '2026-01-20' };
    expect(periodsOverlap(a, { from: '2026-01-20', to: null })).toBe(true);
    expect(periodsOverlap(a, { from: '2026-01-21', to: null })).toBe(false);
    expect(periodsOverlap(a, { from: '2026-01-01', to: '2026-01-10' })).toBe(true);
    expect(periodsOverlap(a, { from: '2026-01-01', to: '2026-01-09' })).toBe(false);
    expect(periodsOverlap({ from: '2026-01-01', to: null }, a)).toBe(true);
  });

  it('closes an open period the day before a new open one (BR-2, BR-4)', () => {
    expect(
      planPeriodInsert([p('a', '2026-01-01', null)], { from: '2026-03-01', to: null }, 'x'),
    ).toEqual({ close: { id: 'a', to: '2026-02-28' } });
    expect(
      planPeriodInsert(
        [p('a', '2026-01-01', '2026-01-31'), p('b', '2026-02-01', null)],
        { from: '2026-03-01', to: null },
        'x',
      ),
    ).toEqual({ close: { id: 'b', to: '2026-02-28' } });
  });

  it('needs no change when nothing is open or the new period is in the past', () => {
    expect(planPeriodInsert([], { from: '2026-03-01', to: null }, 'x')).toEqual({ close: null });
    expect(
      planPeriodInsert([p('a', '2026-03-01', null)], { from: '2026-01-01', to: '2026-02-28' }, 'x'),
    ).toEqual({ close: null });
  });

  it('refuses every other overlap with the given code', () => {
    const open = p('a', '2026-01-01', null);
    // Same start: closing the earlier period would leave it with no days.
    expect(
      codeOf(() => planPeriodInsert([open], { from: '2026-01-01', to: null }, 'rate_overlap')),
    ).toBe('rate_overlap');
    // A closed new period inside an open one would cut the pay after it.
    expect(
      codeOf(() => planPeriodInsert([open], { from: '2026-02-01', to: '2026-02-28' }, 'o')),
    ).toBe('o');
    // A closed earlier period that still runs on the new start.
    expect(
      codeOf(() =>
        planPeriodInsert(
          [p('a', '2026-01-01', '2026-03-31')],
          { from: '2026-03-01', to: null },
          'o',
        ),
      ),
    ).toBe('o');
    // An earlier open period starting later than the new one.
    expect(
      codeOf(() =>
        planPeriodInsert([p('a', '2026-05-01', null)], { from: '2026-03-01', to: null }, 'o'),
      ),
    ).toBe('o');
    // Two open periods cannot both be closed.
    expect(
      codeOf(() =>
        planPeriodInsert(
          [p('a', '2026-01-01', null), p('b', '2026-01-15', null)],
          { from: '2026-03-01', to: null },
          'o',
        ),
      ),
    ).toBe('o');
  });

  it('finds the period in force on a date, on both boundaries (BR-3)', () => {
    const periods = [p('a', '2026-01-01', '2026-01-31'), p('b', '2026-02-01', null)];
    expect(periodAt(periods, '2026-01-01')?.id).toBe('a');
    expect(periodAt(periods, '2026-01-31')?.id).toBe('a');
    expect(periodAt(periods, '2026-02-01')?.id).toBe('b');
    expect(periodAt(periods, '2030-01-01')?.id).toBe('b');
    expect(periodAt(periods, '2025-12-31')).toBeUndefined();
  });

  it('lists the open periods to end when a worker leaves (BR-6)', () => {
    const periods = [p('a', '2026-01-01', '2026-01-31'), p('b', '2026-02-01', null)];
    expect(periodsToCloseAt(periods, '2026-03-01', 'c')).toEqual(['b']);
    expect(periodsToCloseAt(periods, '2026-02-01', 'c')).toEqual(['b']);
    expect(periodsToCloseAt([], '2026-02-01', 'c')).toEqual([]);
    expect(codeOf(() => periodsToCloseAt(periods, '2026-01-15', 'after_leaving'))).toBe(
      'after_leaving',
    );
  });
});

describe('rates (BR-2, BR-3)', () => {
  it('accepts amounts above zero with at most two decimals', () => {
    expect(assertRateAmount('1000')).toBe('1000.00');
    expect(assertRateAmount('1000.5')).toBe('1000.50');
    for (const bad of ['0', '0.00', '-5', '10.123', 'abc', '', '12345678901234567']) {
      expect(
        codeOf(() => assertRateAmount(bad)),
        bad,
      ).toBe('rate_amount_invalid');
    }
  });

  it('uses a daily rate as it is', () => {
    expect(dailyEquivalent({ payBasis: 'daily_rate', amount: '1000.00' }, 0)).toBe('1000.0000');
  });

  it('divides a monthly salary by the working-days basis, half-up to 4 decimals', () => {
    expect(dailyEquivalent({ payBasis: 'monthly_salary', amount: '26000.00' }, 26)).toBe(
      '1000.0000',
    );
    expect(dailyEquivalent({ payBasis: 'monthly_salary', amount: '30000.00' }, 26)).toBe(
      '1153.8462',
    );
    expect(dailyEquivalent({ payBasis: 'monthly_salary', amount: '1.00' }, 3)).toBe('0.3333');
  });

  it('refuses a monthly salary while the basis is not set', () => {
    for (const basis of [0, -1, 1.5, Number.NaN]) {
      expect(
        codeOf(() => dailyEquivalent({ payBasis: 'monthly_salary', amount: '100' }, basis)),
      ).toBe('working_days_basis_not_set');
    }
  });
});

describe('deactivation (BR-6)', () => {
  it('needs a leaving date', () => {
    expect(codeOf(() => assertCanDeactivate(null, []))).toBe('left_on_required');
  });

  it('passes when all attendance is approved', () => {
    expect(assertCanDeactivate('2026-03-01', [])).toBeUndefined();
  });

  it('lists the sheets that are not approved', () => {
    try {
      assertCanDeactivate('2026-03-01', [
        { id: 'sheet-1', date: '2026-02-27' },
        { id: 'sheet-2', date: '2026-02-28' },
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe('unapproved_attendance');
      expect((error as Error).message).toContain('2026-02-27 (sheet-1)');
      expect((error as Error).message).toContain('2026-02-28 (sheet-2)');
    }
  });
});
