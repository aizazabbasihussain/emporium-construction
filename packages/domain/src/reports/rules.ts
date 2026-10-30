import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/business-date.js';

// Pure rules of the operational reports (spec P1-19 section 4). The amounts are computed by the
// owning modules (BR-9); this file only compares, groups and sums them with Decimal arithmetic.

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const money = (value: Decimal): string =>
  value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** The sum of decimal strings, exact to the given number of decimals. Nulls count as nothing. */
export function sumDecimals(values: readonly (string | null)[], places = 2): string {
  return values
    .reduce<Decimal>((sum, value) => (value === null ? sum : sum.plus(new Dec(value))), new Dec(0))
    .toDecimalPlaces(places, Decimal.ROUND_HALF_UP)
    .toFixed(places);
}

export interface CostFigures {
  budget: string;
  committed: string;
  approved: string;
  posted: string;
}

export interface CostStatus extends CostFigures {
  /** BR-1: committed + approved + posted. */
  used: string;
  /** BR-1: budget - used; negative when the project has overspent. */
  variance: string;
  /** BR-1: used / budget as a percentage to two decimals; null when the budget is zero. */
  percentUsed: string | null;
}

/** BR-1: the status of one cost code or of a whole project. */
export function costStatus(figures: CostFigures): CostStatus {
  const used = new Dec(figures.committed).plus(figures.approved).plus(figures.posted);
  const budget = new Dec(figures.budget);
  return {
    ...figures,
    used: money(used),
    variance: money(budget.minus(used)),
    percentUsed: budget.isZero() ? null : money(used.div(budget).times(100)),
  };
}

/** BR-1: the sum of cost codes, with the status worked out again from the summed figures. */
export function totalCostStatus(lines: readonly CostFigures[]): CostStatus {
  return costStatus({
    budget: sumDecimals(lines.map((line) => line.budget)),
    committed: sumDecimals(lines.map((line) => line.committed)),
    approved: sumDecimals(lines.map((line) => line.approved)),
    posted: sumDecimals(lines.map((line) => line.posted)),
  });
}

/** BR-1: the most overspent first (lowest variance), then the key, so the order is stable. */
export function compareOverspend(
  a: { variance: string; key: string },
  b: { variance: string; key: string },
): number {
  return new Dec(a.variance).comparedTo(b.variance) || a.key.localeCompare(b.key);
}

export interface Page {
  limit: number;
  offset: number;
}

/** BR-11: 50 rows by default and 200 at most. */
export function normalizePage(
  limit: number | undefined,
  offset: number | undefined,
  defaults = { size: 50, max: 200 },
): Page {
  const size = limit ?? defaults.size;
  if (!Number.isInteger(size) || size < 1 || size > defaults.max) {
    throw new ValidationError('page_invalid', `The page size is between 1 and ${defaults.max}`);
  }
  const start = offset ?? 0;
  if (!Number.isInteger(start) || start < 0) {
    throw new ValidationError('page_invalid', 'The page offset cannot be negative');
  }
  return { limit: size, offset: start };
}

export type SortDirection = 'asc' | 'desc';

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Compares two cells: numbers as decimals (never as floats), everything else as text. */
export function compareCells(a: string | number, b: string | number): number {
  const x = String(a);
  const y = String(b);
  if (NUMERIC.test(x) && NUMERIC.test(y)) return new Dec(x).comparedTo(y);
  return x.localeCompare(y);
}

/** BR-11: sorts by one column on the server. Empty cells stay last, equal rows keep their order. */
export function sortRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  key: keyof T & string,
  direction: SortDirection,
): T[] {
  const sign = direction === 'desc' ? -1 : 1;
  const cell = (row: T) => (row[key] ?? null) as string | number | null;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const x = cell(a.row);
      const y = cell(b.row);
      if (x === null || y === null) {
        return (x === null ? 1 : 0) - (y === null ? 1 : 0) || a.index - b.index;
      }
      return sign * compareCells(x, y) || a.index - b.index;
    })
    .map((entry) => entry.row);
}

export interface PageOf<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** BR-11: the page of an already filtered and sorted set; `total` counts the whole set. */
export function pageOf<T>(rows: readonly T[], page: Page): PageOf<T> {
  return {
    items: rows.slice(page.offset, page.offset + page.limit),
    total: rows.length,
    ...page,
  };
}

/** BR-3: an expected date before today (Asia/Karachi) is overdue; no date is never overdue. */
export function isOverdue(expectedDate: string | null, today: string): boolean {
  return expectedDate !== null && expectedDate < today;
}

export interface DprCompliance {
  expectedDays: number;
  submittedDays: number;
  missingDays: number;
  /** The missing dates, oldest first. */
  missingDates: string[];
  /** Submitted over expected as a percentage to two decimals; null when no day was expected. */
  percentSubmitted: string | null;
}

/**
 * BR-5: of the days a report was expected, the ones with a submitted (or reviewed) report and the
 * ones without. A report on a day that was not expected (a weekend, a holiday) is not counted.
 */
export function dprCompliance(
  expectedDates: readonly string[],
  submittedDates: readonly string[],
): DprCompliance {
  const submitted = new Set(submittedDates);
  const missingDates = expectedDates.filter((date) => !submitted.has(date));
  const expectedDays = expectedDates.length;
  const submittedDays = expectedDays - missingDates.length;
  return {
    expectedDays,
    submittedDays,
    missingDays: missingDates.length,
    missingDates,
    percentSubmitted:
      expectedDays === 0 ? null : money(new Dec(submittedDays).div(expectedDays).times(100)),
  };
}

/** The `yyyy-mm` month of a business date. */
export const monthOf = (date: string): string => date.slice(0, 7);

/** The months from the one of `from` to the one of `to`, both included. */
export function monthsBetween(from: string, to: string): string[] {
  const [fromYear, fromMonth] = from.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = to.split('-').map(Number) as [number, number];
  const months: string[] = [];
  for (let index = fromYear * 12 + fromMonth - 1; index <= toYear * 12 + toMonth - 1; index += 1) {
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
  }
  return months;
}

const MAX_REPORT_DAYS = 366;

/** A report period: valid dates, not backwards, and at most a year (366 days) long. */
export function assertReportPeriod(from: string, to: string, maxDays = MAX_REPORT_DAYS): void {
  const start = BusinessDate.parse(from);
  const end = BusinessDate.parse(to);
  if (start.isAfter(end)) {
    throw new ValidationError('period_invalid', 'The period ends before it starts');
  }
  if (end.daysSince(start) >= maxDays) {
    throw new ValidationError('period_too_long', `The period is limited to ${maxDays} days`);
  }
}
