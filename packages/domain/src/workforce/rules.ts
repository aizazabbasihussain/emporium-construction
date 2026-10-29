import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/business-date.js';

// Pure workforce rules (spec P1-16 section 4). Nothing here touches a database.

export type EmploymentType = 'permanent' | 'daily' | 'contract';
export type PayBasis = 'daily_rate' | 'monthly_salary';

/** BR-1: a CNIC is required, except for a contract worker who is brought by a contractor. */
export function assertWorkerIdentity(worker: {
  employmentType: EmploymentType;
  cnic: string | null;
  contractorPartyId: string | null;
}): void {
  if (worker.cnic !== null) return;
  if (worker.employmentType === 'contract' && worker.contractorPartyId !== null) return;
  throw new ValidationError(
    'cnic_required',
    'A CNIC is required unless a contract worker is brought by a contractor',
  );
}

/** BR-8: only the last 4 digits of a sensitive value are shown in lists and logs. */
export function maskLast4(value: string | null): string | null {
  if (value === null) return null;
  const visible = value.slice(-4);
  return `${'*'.repeat(Math.max(value.length - visible.length, 0))}${visible}`;
}

/** A period of dates, both ends included; an open end means "until further notice". */
export interface Period {
  id: string;
  from: string;
  to: string | null;
}

export interface NewPeriod {
  from: string;
  to: string | null;
}

/** The change to an earlier open period that a new one brings with it. */
export interface PeriodPlan {
  /** The open period that ends the day before the new one starts, if any. */
  close: { id: string; to: string } | null;
}

export function assertValidPeriod(period: NewPeriod): void {
  const from = BusinessDate.parse(period.from);
  if (period.to !== null && from.isAfter(BusinessDate.parse(period.to))) {
    throw new ValidationError('period_invalid', 'The end date cannot be before the start date');
  }
}

/** Both ends included. ISO dates compare as text. */
export function periodsOverlap(a: NewPeriod, b: NewPeriod): boolean {
  const aEndsBeforeB = a.to !== null && a.to < b.from;
  const bEndsBeforeA = b.to !== null && b.to < a.from;
  return !aEndsBeforeB && !bEndsBeforeA;
}

/**
 * BR-2 and BR-4: a new period may not overlap an existing one. The single exception is an
 * open-ended new period that starts after an open-ended earlier one: the earlier one is closed the
 * day before.
 */
export function planPeriodInsert(
  existing: readonly Period[],
  candidate: NewPeriod,
  overlapCode: string,
): PeriodPlan {
  assertValidPeriod(candidate);
  let close: PeriodPlan['close'] = null;
  for (const period of existing) {
    if (!periodsOverlap(period, candidate)) continue;
    const closable =
      candidate.to === null && period.to === null && period.from < candidate.from && close === null;
    if (!closable) {
      throw new RuleViolationError(overlapCode, 'The dates overlap an existing period');
    }
    close = { id: period.id, to: BusinessDate.parse(candidate.from).addDays(-1).toString() };
  }
  return { close };
}

/** The period that contains the date, if any. */
export function periodAt<T extends NewPeriod>(periods: readonly T[], date: string): T | undefined {
  return periods.find((period) => period.from <= date && (period.to === null || date <= period.to));
}

/**
 * BR-6: periods that are still open when a worker leaves end on the leaving date. A period that
 * only starts after that date cannot be ended on it.
 */
export function periodsToCloseAt(
  periods: readonly Period[],
  leftOn: string,
  code: string,
): string[] {
  const open = periods.filter((period) => period.to === null);
  if (open.some((period) => period.from > leftOn)) {
    throw new RuleViolationError(code, 'A period starts after the leaving date');
  }
  return open.map((period) => period.id);
}

export interface RateInput {
  payBasis: PayBasis;
  amount: string;
}

/** BR-2: an amount greater than zero, with at most 2 decimals. */
export function assertRateAmount(amount: string): string {
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(amount) || new Decimal(amount).lte(0)) {
    throw new ValidationError('rate_amount_invalid', 'The amount must be greater than zero');
  }
  return new Decimal(amount).toFixed(2);
}

/**
 * BR-3: the pay for one day. A daily rate is the day rate; a monthly salary is divided by the
 * working-days basis (H-11), rounded half-up to 4 decimals, the precision of a rate.
 */
export function dailyEquivalent(rate: RateInput, workingDaysBasis: number): string {
  if (rate.payBasis === 'daily_rate') return new Decimal(rate.amount).toFixed(4);
  if (!Number.isInteger(workingDaysBasis) || workingDaysBasis < 1) {
    throw new RuleViolationError(
      'working_days_basis_not_set',
      'The working-days basis of a month is not set',
    );
  }
  return new Decimal(rate.amount)
    .div(workingDaysBasis)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
    .toFixed(4);
}

export interface UnapprovedSheet {
  id: string;
  date: string;
}

/**
 * BR-6: leaving needs a leaving date, and attendance up to that date must be approved first; the
 * error lists the sheets that are not.
 */
export function assertCanDeactivate(leftOn: string | null, unapproved: readonly UnapprovedSheet[]) {
  if (leftOn === null) {
    throw new ValidationError('left_on_required', 'A leaving date is required to deactivate');
  }
  if (unapproved.length > 0) {
    const list = unapproved.map((sheet) => `${sheet.date} (${sheet.id})`).join(', ');
    throw new RuleViolationError(
      'unapproved_attendance',
      `Approve these attendance sheets first: ${list}`,
    );
  }
}
