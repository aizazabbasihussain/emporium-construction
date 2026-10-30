import { describe, expect, it } from 'vitest';
import {
  allocationCostKey,
  assertSheetEditable,
  assertSheetTransition,
  assertSubmittable,
  entryAmounts,
  entryCost,
  entryStatuses,
  isWorked,
  normalizeEntries,
  overtimeCostKey,
  sheetStatuses,
  sheetTransitions,
  splitAmount,
  sumAmounts,
  workingDates,
  type EntryInput,
  type SheetStatus,
} from './index.js';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

const worked = (over: Partial<EntryInput> = {}): EntryInput => ({
  workerId: 'w1',
  status: 'present',
  allocations: [{ projectId: 'p1', fraction: '1' }],
  ...over,
});

describe('sheet state machine (T-5)', () => {
  it('allows exactly the listed transitions and refuses every other pair', () => {
    for (const from of sheetStatuses) {
      for (const to of sheetStatuses) {
        const allowed = sheetTransitions[from].includes(to);
        expect(
          codeOf(() => assertSheetTransition(from, to)),
          `${from} -> ${to}`,
        ).toBe(allowed ? 'no error' : 'sheet_transition');
      }
    }
  });

  it('lists the table the spec describes', () => {
    expect(sheetTransitions).toEqual({
      draft: ['submitted'],
      submitted: ['approved', 'rejected', 'draft'],
      approved: ['unlocked'],
      rejected: ['submitted'],
      unlocked: ['submitted'],
    });
  });

  it('lets a draft, rejected or unlocked sheet be edited and locks the others (BR-7)', () => {
    const editable = (s: SheetStatus) => codeOf(() => assertSheetEditable(s)) === 'no error';
    expect(sheetStatuses.filter(editable)).toEqual(['draft', 'rejected', 'unlocked']);
    expect(codeOf(() => assertSheetEditable('approved'))).toBe('sheet_read_only');
  });

  it('refuses to submit an empty sheet', () => {
    expect(codeOf(() => assertSubmittable(0))).toBe('sheet_empty');
    expect(codeOf(() => assertSubmittable(1))).toBe('no error');
  });
});

describe('allocation rules (T-1)', () => {
  it('accepts a day split in two that adds up to exactly 1', () => {
    const [entry] = normalizeEntries([
      worked({
        allocations: [
          { projectId: 'p1', fraction: '0.6', costCodeId: 'c1' },
          { projectId: 'p2', fraction: '0.4000' },
        ],
      }),
    ]);
    expect(entry?.allocations).toEqual([
      { projectId: 'p1', fraction: '0.6000', costCodeId: 'c1' },
      { projectId: 'p2', fraction: '0.4000', costCodeId: null },
    ]);
  });

  it('keeps four decimals so thirds can add up to exactly 1', () => {
    const [entry] = normalizeEntries([
      worked({
        allocations: [
          { projectId: 'p1', fraction: '0.3333' },
          { projectId: 'p2', fraction: '0.3333' },
          { projectId: 'p3', fraction: '0.3334' },
        ],
      }),
    ]);
    expect(entry?.allocations.map((a) => a.fraction)).toEqual(['0.3333', '0.3333', '0.3334']);
  });

  it('rejects a sum of 0.999, a sum above 1 and a fifth decimal', () => {
    const sum = (...fractions: string[]) =>
      codeOf(() =>
        normalizeEntries([
          worked({ allocations: fractions.map((f, i) => ({ projectId: `p${i}`, fraction: f })) }),
        ]),
      );
    expect(sum('0.999')).toBe('allocation_sum');
    expect(sum('0.5', '0.6')).toBe('allocation_sum');
    expect(sum('0.33333', '0.66667')).toBe('fraction_invalid');
  });

  it('rejects fractions that are not a number from above 0 up to 1', () => {
    const one = (fraction: string) =>
      codeOf(() => normalizeEntries([worked({ allocations: [{ projectId: 'p', fraction }] })]));
    expect(one('0')).toBe('fraction_invalid');
    expect(one('0.0000')).toBe('fraction_invalid');
    expect(one('1.5')).toBe('allocation_sum');
    expect(one('2')).toBe('fraction_invalid');
    expect(one('-1')).toBe('fraction_invalid');
    expect(one('abc')).toBe('fraction_invalid');
    expect(one(' 1 ')).toBe('no error');
  });

  it('rejects the same project twice in a day', () => {
    expect(
      codeOf(() =>
        normalizeEntries([
          worked({
            allocations: [
              { projectId: 'p1', fraction: '0.5' },
              { projectId: 'p1', fraction: '0.5' },
            ],
          }),
        ]),
      ),
    ).toBe('allocation_project_duplicated');
  });

  it('needs allocations on present and half days and refuses them on every other status', () => {
    for (const status of entryStatuses) {
      const withNone = codeOf(() =>
        normalizeEntries([{ workerId: 'w', status, allocations: undefined }]),
      );
      const withOne = codeOf(() =>
        normalizeEntries([
          { workerId: 'w', status, allocations: [{ projectId: 'p', fraction: '1' }] },
        ]),
      );
      if (isWorked(status)) {
        expect(withNone, status).toBe('allocations_required');
        expect(withOne, status).toBe('no error');
      } else {
        expect(withNone, status).toBe('no error');
        expect(withOne, status).toBe('allocations_not_allowed');
      }
    }
  });

  it('accepts an empty allocation list on a non-worked day and returns none', () => {
    const [entry] = normalizeEntries([{ workerId: 'w', status: 'absent', allocations: [] }]);
    expect(entry?.allocations).toEqual([]);
  });

  it('refuses a worker twice on one sheet', () => {
    expect(codeOf(() => normalizeEntries([worked(), worked()]))).toBe('worker_duplicated');
  });

  it('trims remarks and turns empty remarks into null', () => {
    const [a, b, c] = normalizeEntries([
      worked({ workerId: 'a', remarks: '  late  ' }),
      worked({ workerId: 'b', remarks: '   ' }),
      worked({ workerId: 'c' }),
    ]);
    expect([a?.remarks, b?.remarks, c?.remarks]).toEqual(['late', null, null]);
  });
});

describe('overtime limits (BR-5)', () => {
  const hours = (overtimeHours: string | null | undefined, extra: Partial<EntryInput> = {}) =>
    codeOf(() => normalizeEntries([worked({ overtimeHours, ...extra })]));

  it('allows 0 to 8 hours with at most two decimals', () => {
    expect(hours('0')).toBe('no error');
    expect(hours('8')).toBe('no error');
    expect(hours('2.25')).toBe('no error');
    expect(hours(null)).toBe('no error');
    expect(hours(undefined)).toBe('no error');
    const [entry] = normalizeEntries([worked({ overtimeHours: '2.5' })]);
    expect(entry?.overtimeHours).toBe('2.50');
  });

  it('refuses more than 8 hours, odd spellings and overtime on a day without work', () => {
    expect(hours('8.01')).toBe('overtime_out_of_range');
    expect(hours('9')).toBe('overtime_out_of_range');
    expect(hours('-1')).toBe('overtime_invalid');
    expect(hours('1.234')).toBe('overtime_invalid');
    expect(hours('abc')).toBe('overtime_invalid');
    expect(
      codeOf(() => normalizeEntries([{ workerId: 'w', status: 'absent', overtimeHours: '1' }])),
    ).toBe('overtime_not_allowed');
  });

  it('allows an overtime project only with overtime hours', () => {
    expect(hours('1', { overtimeProjectId: 'p9' })).toBe('no error');
    expect(hours('0', { overtimeProjectId: 'p9' })).toBe('overtime_project_without_hours');
    expect(hours(undefined, { overtimeProjectId: 'p9' })).toBe('overtime_project_without_hours');
  });
});

describe('day value and overtime (T-2)', () => {
  const cost = (status: 'present' | 'half_day' | 'absent', overtimeHours = '0', rate = '1000') =>
    entryCost({ status, dailyRate: rate, overtimeHours, multiplier: '2' });

  it('uses the worked example: rate 1,000, present 1,000, half day 500, OT 2 hours at x2 is 500', () => {
    expect(cost('present')).toEqual({ dayValue: '1000.00', overtimeValue: '0.00' });
    expect(cost('half_day')).toEqual({ dayValue: '500.00', overtimeValue: '0.00' });
    expect(cost('absent')).toEqual({ dayValue: '0.00', overtimeValue: '0.00' });
    expect(cost('present', '2')).toEqual({ dayValue: '1000.00', overtimeValue: '500.00' });
  });

  it('prices a monthly salary through its daily equivalent, rounding half-up to cents', () => {
    // 30,000 / 26 = 1153.8462 (4 decimals, as getWorkerRate returns it).
    expect(
      entryCost({
        status: 'present',
        dailyRate: '1153.8462',
        overtimeHours: '2',
        multiplier: '1.5',
      }),
    ).toEqual({ dayValue: '1153.85', overtimeValue: '432.69' });
    expect(
      entryCost({
        status: 'half_day',
        dailyRate: '1153.8462',
        overtimeHours: '0',
        multiplier: '1.5',
      }).dayValue,
    ).toBe('576.92');
  });
});

describe('splitting an amount over allocations (AC-2)', () => {
  it('divides exactly when the shares are whole', () => {
    expect(splitAmount('1000.00', ['0.6000', '0.4000'])).toEqual(['600.00', '400.00']);
    expect(splitAmount('1000.00', ['1.0000'])).toEqual(['1000.00']);
    expect(splitAmount('0.00', [])).toEqual([]);
  });

  it('moves a lost cent to a line that was rounded down', () => {
    // With 1000.01 the rounded lines (333.30, 333.30, 333.40) add up to 1000.00: the cent goes to
    // the line that was rounded down the furthest.
    expect(splitAmount('1000.01', ['0.3333', '0.3333', '0.3334'])).toEqual([
      '333.30',
      '333.30',
      '333.41',
    ]);
  });

  it('takes back a cent from a line that was rounded up, never leaving a negative line', () => {
    // 0.5 x 1000.01 = 500.005: both lines round up to 500.01 (1000.02), one gives a cent back.
    expect(splitAmount('1000.01', ['0.5000', '0.5000'])).toEqual(['500.00', '500.01']);
    expect(splitAmount('0.02', ['0.2500', '0.2500', '0.2500', '0.2500'])).toEqual([
      '0.00',
      '0.00',
      '0.01',
      '0.01',
    ]);
  });
});

describe('what an entry costs per project (BR-5, BR-6)', () => {
  const base = {
    allocations: [{ fraction: '0.5000' }, { fraction: '0.5000' }],
    overtimeProjectId: null,
    dayValue: '1000.00',
    overtimeValue: '0.00',
  };

  it('splits the day value over the allocations', () => {
    expect(entryAmounts(base)).toEqual({ allocations: ['500.00', '500.00'], overtime: null });
  });

  it('adds overtime to the first allocation unless it has its own project', () => {
    expect(entryAmounts({ ...base, overtimeValue: '250.00' })).toEqual({
      allocations: ['750.00', '500.00'],
      overtime: null,
    });
    expect(entryAmounts({ ...base, overtimeValue: '250.00', overtimeProjectId: 'p9' })).toEqual({
      allocations: ['500.00', '500.00'],
      overtime: '250.00',
    });
  });

  it('adds money amounts exactly', () => {
    expect(sumAmounts(['0.10', '0.20', '1000.01'])).toBe('1000.31');
    expect(sumAmounts([])).toBe('0.00');
  });

  it('builds the idempotency keys of the ledger entries', () => {
    expect(allocationCostKey('e1', 'a1')).toBe('att:e1:a1');
    expect(overtimeCostKey('e1')).toBe('att:e1:ot');
  });
});

describe('working dates for missing-sheet detection (T-6)', () => {
  it('lists Monday to Friday and skips weekends', () => {
    // 2026-10-26 is a Monday.
    expect(workingDates('2026-10-24', '2026-11-02', '2026-11-30', '')).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-11-02',
    ]);
  });

  it('skips site holidays, ignoring entries that are not dates', () => {
    expect(
      workingDates('2026-10-26', '2026-10-28', '2026-11-30', ' 2026-10-27 , nonsense ,'),
    ).toEqual(['2026-10-26', '2026-10-28']);
  });

  it('never goes past today', () => {
    expect(workingDates('2026-10-26', '2026-10-30', '2026-10-27', '')).toEqual([
      '2026-10-26',
      '2026-10-27',
    ]);
    expect(workingDates('2026-10-26', '2026-10-26', '2026-10-25', '')).toEqual([]);
  });

  it('refuses a backwards or oversized period', () => {
    expect(codeOf(() => workingDates('2026-10-30', '2026-10-26', '2026-11-30', ''))).toBe(
      'period_invalid',
    );
    expect(codeOf(() => workingDates('2026-01-01', '2026-06-30', '2026-11-30', ''))).toBe(
      'period_too_long',
    );
    expect(codeOf(() => workingDates('2026-01-01', '2026-03-30', '2026-11-30', ''))).toBe(
      'no error',
    );
  });
});
