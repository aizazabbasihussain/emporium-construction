import { describe, expect, it } from 'vitest';
import {
  assertReportPeriod,
  compareCells,
  compareOverspend,
  costStatus,
  dprCompliance,
  isOverdue,
  monthOf,
  monthsBetween,
  normalizePage,
  pageOf,
  ratioPercent,
  sortRows,
  sumDecimals,
  totalCostStatus,
  type CostFigures,
} from './index.js';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

describe('cost status (BR-1, T-2)', () => {
  it('uses committed + approved + posted and reports variance and percent used', () => {
    expect(
      costStatus({ budget: '1000.00', committed: '100.00', approved: '200.00', posted: '300.00' }),
    ).toEqual({
      budget: '1000.00',
      committed: '100.00',
      approved: '200.00',
      posted: '300.00',
      used: '600.00',
      variance: '400.00',
      percentUsed: '60.00',
    });
  });

  it('shows an overspend as a negative variance and a percent above 100', () => {
    const status = costStatus({
      budget: '300.00',
      committed: '0.00',
      approved: '200.00',
      posted: '150.50',
    });
    expect(status.variance).toBe('-50.50');
    expect(status.percentUsed).toBe('116.83');
  });

  it('has no percent when the budget is zero, whatever was spent', () => {
    expect(
      costStatus({ budget: '0.00', committed: '0.00', approved: '0.00', posted: '0.00' })
        .percentUsed,
    ).toBeNull();
    const spent = costStatus({ budget: '0', committed: '10', approved: '0', posted: '0' });
    expect(spent.percentUsed).toBeNull();
    expect(spent.variance).toBe('-10.00');
  });

  it('rounds the percent half up to two decimals', () => {
    expect(
      costStatus({ budget: '3', committed: '1', approved: '0', posted: '0' }).percentUsed,
    ).toBe('33.33');
    expect(
      costStatus({ budget: '8', committed: '1', approved: '0', posted: '0' }).percentUsed,
    ).toBe('12.50');
    expect(
      costStatus({ budget: '200', committed: '0.01', approved: '0', posted: '0' }).percentUsed,
    ).toBe('0.01');
  });

  it('orders the most overspent first and then by key', () => {
    const rows = [
      { key: 'b', variance: '10.00' },
      { key: 'c', variance: '-500.00' },
      { key: 'a', variance: '10.00' },
      { key: 'd', variance: '-20.00' },
    ];
    expect([...rows].sort(compareOverspend).map((row) => row.key)).toEqual(['c', 'd', 'a', 'b']);
  });
});

describe('totals (T-6)', () => {
  it('totals the figures of several cost codes', () => {
    const lines: CostFigures[] = [
      { budget: '100.00', committed: '10.00', approved: '20.00', posted: '30.00' },
      { budget: '50.00', committed: '0.00', approved: '0.00', posted: '5.00' },
    ];
    expect(totalCostStatus(lines)).toMatchObject({
      budget: '150.00',
      used: '65.00',
      variance: '85.00',
    });
  });

  it('sums decimals exactly and ignores empty cells', () => {
    expect(sumDecimals(['0.10', '0.20', null])).toBe('0.30');
    expect(sumDecimals([])).toBe('0.00');
    expect(sumDecimals(['1.5', '2.25'], 4)).toBe('3.7500');
  });
});

describe('paging, sorting and totals over the whole set (BR-11, T-4)', () => {
  it('defaults to 50 rows and refuses more than 200 or a bad offset', () => {
    expect(normalizePage(undefined, undefined)).toEqual({ limit: 50, offset: 0 });
    expect(normalizePage(200, 10)).toEqual({ limit: 200, offset: 10 });
    expect(codeOf(() => normalizePage(201, 0))).toBe('page_invalid');
    expect(codeOf(() => normalizePage(0, 0))).toBe('page_invalid');
    expect(codeOf(() => normalizePage(1.5, 0))).toBe('page_invalid');
    expect(codeOf(() => normalizePage(10, -1))).toBe('page_invalid');
    expect(codeOf(() => normalizePage(10, 0.5))).toBe('page_invalid');
  });

  it('cuts a page and keeps the count of the whole set', () => {
    const rows = Array.from({ length: 120 }, (_, i) => i);
    const page = pageOf(rows, { limit: 50, offset: 100 });
    expect(page.items).toHaveLength(20);
    expect(page.total).toBe(120);
    expect(pageOf(rows, { limit: 50, offset: 500 }).items).toEqual([]);
  });

  it('compares numbers as decimals and text as text', () => {
    expect(compareCells('9', '10')).toBeLessThan(0);
    expect(compareCells('10.50', '10.5')).toBe(0);
    expect(compareCells(2, '10')).toBeLessThan(0);
    expect(compareCells('-5', '3')).toBeLessThan(0);
    expect(compareCells('apple', 'banana')).toBeLessThan(0);
  });

  it('sorts by a column in both directions with empty cells last and a stable order', () => {
    const rows = [
      { id: 'a', amount: '10.00' },
      { id: 'b', amount: null },
      { id: 'c', amount: '9.00' },
      { id: 'd', amount: '10.00' },
      { id: 'e', amount: null },
    ];
    expect(sortRows(rows, 'amount', 'asc').map((r) => r.id)).toEqual(['c', 'a', 'd', 'b', 'e']);
    expect(sortRows(rows, 'amount', 'desc').map((r) => r.id)).toEqual(['a', 'd', 'c', 'b', 'e']);
    expect(sortRows(rows, 'id', 'desc').map((r) => r.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });
});

describe('overdue and compliance (BR-3, BR-5)', () => {
  it('a purchase order line is overdue only when its date is before today', () => {
    expect(isOverdue('2026-10-24', '2026-10-25')).toBe(true);
    expect(isOverdue('2026-10-25', '2026-10-25')).toBe(false);
    expect(isOverdue(null, '2026-10-25')).toBe(false);
  });

  it('counts submitted against missing days and ignores reports on days not expected', () => {
    const result = dprCompliance(
      ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'],
      ['2026-10-19', '2026-10-21', '2026-10-24'],
    );
    expect(result).toEqual({
      expectedDays: 4,
      submittedDays: 2,
      missingDays: 2,
      missingDates: ['2026-10-20', '2026-10-22'],
      percentSubmitted: '50.00',
    });
    expect(dprCompliance([], ['2026-10-24']).percentSubmitted).toBeNull();
    expect(dprCompliance(['2026-10-19'], ['2026-10-19']).percentSubmitted).toBe('100.00');
  });
});

describe('ratioPercent', () => {
  it('is a percentage with two decimals, half up, and empty without a whole', () => {
    expect(ratioPercent(1, 3)).toBe('33.33');
    expect(ratioPercent(2, 3)).toBe('66.67');
    expect(ratioPercent(0, 5)).toBe('0.00');
    expect(ratioPercent(5, 5)).toBe('100.00');
    expect(ratioPercent(3, 0)).toBeNull();
  });
});

describe('report period', () => {
  it('accepts a year at most, in order, with real dates', () => {
    expect(codeOf(() => assertReportPeriod('2026-01-01', '2026-12-31'))).toBe('no error');
    expect(codeOf(() => assertReportPeriod('2026-10-25', '2026-10-25'))).toBe('no error');
    expect(codeOf(() => assertReportPeriod('2026-10-25', '2026-10-24'))).toBe('period_invalid');
    expect(codeOf(() => assertReportPeriod('2026-01-01', '2027-06-01'))).toBe('period_too_long');
    expect(codeOf(() => assertReportPeriod('2026-01-01', '2026-02-20', 30))).toBe(
      'period_too_long',
    );
    expect(codeOf(() => assertReportPeriod('x', '2026-02-20'))).toBe('invalid_date');
  });
});

describe('months', () => {
  it('lists the months of a period, across a year end', () => {
    expect(monthOf('2026-10-25')).toBe('2026-10');
    expect(monthsBetween('2026-11-30', '2027-02-01')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
    expect(monthsBetween('2026-10-05', '2026-10-25')).toEqual(['2026-10']);
    expect(monthsBetween('2026-11-01', '2026-10-01')).toEqual([]);
  });
});
