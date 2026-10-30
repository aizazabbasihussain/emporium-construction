import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/business-date.js';
import { parseSiteHolidays } from '../dpr/rules.js';

// Pure attendance rules (spec P1-17 section 4). Nothing here touches a database.

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const sheetStatuses = ['draft', 'submitted', 'approved', 'rejected', 'unlocked'] as const;
export type SheetStatus = (typeof sheetStatuses)[number];

export const entryStatuses = [
  'present',
  'half_day',
  'absent',
  'leave_paid',
  'leave_unpaid',
  'off',
] as const;
export type EntryStatus = (typeof entryStatuses)[number];

/**
 * Constitution 5.8, BR-6 to BR-8: the allowed sheet transitions as an explicit table. A rejected
 * sheet returns to the supervisor, who corrects and submits it again; an approved sheet is locked
 * until it is unlocked, and an unlocked one is corrected and submitted again. A submitted sheet whose
 * approval request was withdrawn goes back to draft.
 */
export const sheetTransitions: Record<SheetStatus, readonly SheetStatus[]> = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected', 'draft'],
  approved: ['unlocked'],
  rejected: ['submitted'],
  unlocked: ['submitted'],
};

export function assertSheetTransition(from: SheetStatus, to: SheetStatus): void {
  if (!sheetTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'sheet_transition',
      `An attendance sheet cannot go from ${from} to ${to}`,
    );
  }
}

/** BR-7: an approved sheet is locked; a submitted one is with the approver. */
export function assertSheetEditable(status: SheetStatus): void {
  if (status === 'submitted' || status === 'approved') {
    throw new RuleViolationError(
      'sheet_read_only',
      'Only a draft, rejected or unlocked attendance sheet can be edited',
    );
  }
}

/** BR-5: overtime is limited to 0 to 8 hours per day per entry. */
export const MAX_OVERTIME_HOURS = 8;

export interface AllocationInput {
  projectId: string;
  fraction: string;
  costCodeId?: string | null | undefined;
}

export interface EntryInput {
  workerId: string;
  status: EntryStatus;
  overtimeHours?: string | null | undefined;
  overtimeProjectId?: string | null | undefined;
  remarks?: string | null | undefined;
  allocations?: readonly AllocationInput[] | undefined;
}

export interface Allocation {
  projectId: string;
  /** Four decimals, as stored. */
  fraction: string;
  costCodeId: string | null;
}

export interface Entry {
  workerId: string;
  status: EntryStatus;
  /** Two decimals, as stored. */
  overtimeHours: string;
  overtimeProjectId: string | null;
  remarks: string | null;
  allocations: Allocation[];
}

/** `present` and `half_day` carry project cost; every other status carries none (BR-3). */
export const isWorked = (status: EntryStatus): boolean =>
  status === 'present' || status === 'half_day';

function fractionOf(text: string): Decimal {
  if (!/^(0|1)(\.\d{1,4})?$/.test(text.trim())) {
    throw new ValidationError(
      'fraction_invalid',
      'An allocation fraction is a number from 0 to 1 with at most four decimals',
    );
  }
  const value = new Dec(text.trim());
  if (!value.greaterThan(0)) {
    throw new ValidationError('fraction_invalid', 'An allocation fraction must be above zero');
  }
  return value;
}

function overtimeOf(entry: EntryInput): string {
  const text = (entry.overtimeHours ?? '0').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) {
    throw new ValidationError('overtime_invalid', 'Overtime hours have at most two decimals');
  }
  const hours = new Dec(text);
  if (hours.greaterThan(MAX_OVERTIME_HOURS)) {
    throw new ValidationError(
      'overtime_out_of_range',
      `Overtime is limited to ${MAX_OVERTIME_HOURS} hours a day`,
    );
  }
  if (hours.greaterThan(0) && !isWorked(entry.status)) {
    throw new ValidationError(
      'overtime_not_allowed',
      'Overtime can only be recorded on a present or half day',
    );
  }
  if (hours.isZero() && entry.overtimeProjectId) {
    throw new ValidationError(
      'overtime_project_without_hours',
      'An overtime project needs overtime hours',
    );
  }
  return hours.toFixed(2);
}

function allocationsOf(entry: EntryInput): Allocation[] {
  const given = entry.allocations ?? [];
  if (!isWorked(entry.status)) {
    if (given.length > 0) {
      throw new ValidationError(
        'allocations_not_allowed',
        `A ${entry.status} entry has no project allocation`,
      );
    }
    return [];
  }
  if (given.length === 0) {
    throw new ValidationError('allocations_required', 'A present or half day needs a project');
  }
  const allocations = given.map((item): Allocation => ({
    projectId: item.projectId,
    fraction: fractionOf(item.fraction).toFixed(4),
    costCodeId: item.costCodeId ?? null,
  }));
  if (new Set(allocations.map((a) => a.projectId)).size !== allocations.length) {
    throw new ValidationError(
      'allocation_project_duplicated',
      'A project can appear only once in a day',
    );
  }
  const sum = allocations.reduce((total, a) => total.plus(a.fraction), new Dec(0));
  if (!sum.equals(1)) {
    throw new ValidationError(
      'allocation_sum',
      `The allocations of a day must add up to exactly 1, not ${sum.toString()}`,
    );
  }
  return allocations;
}

/** BR-2, BR-3, BR-5: checks every entry of a sheet and returns it in stored form. */
export function normalizeEntries(inputs: readonly EntryInput[]): Entry[] {
  if (new Set(inputs.map((entry) => entry.workerId)).size !== inputs.length) {
    throw new ValidationError('worker_duplicated', 'A worker can appear only once on a sheet');
  }
  return inputs.map((entry) => {
    const remarks = entry.remarks?.trim() ?? '';
    return {
      workerId: entry.workerId,
      status: entry.status,
      overtimeHours: overtimeOf(entry),
      overtimeProjectId: entry.overtimeProjectId ?? null,
      remarks: remarks === '' ? null : remarks,
      allocations: allocationsOf(entry),
    };
  });
}

/** A sheet with nothing on it cannot be submitted. */
export function assertSubmittable(entryCount: number): void {
  if (entryCount === 0) {
    throw new RuleViolationError('sheet_empty', 'An attendance sheet needs at least one worker');
  }
}

const round2 = (value: Decimal): Decimal => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export interface CostInput {
  status: EntryStatus;
  /** The daily-equivalent rate of the worker on the day (from `getWorkerRate`). */
  dailyRate: string;
  overtimeHours: string;
  /** The overtime multiplier setting (H-11). */
  multiplier: string;
}

export interface EntryCost {
  dayValue: string;
  overtimeValue: string;
}

/**
 * BR-4, BR-5: `present` is one daily rate, `half_day` half of it, every other status nothing.
 * Overtime is hours x (daily rate / 8) x multiplier. Both are rounded half-up to 2 decimals.
 */
export function entryCost(input: CostInput): EntryCost {
  const rate = new Dec(input.dailyRate);
  const factor = input.status === 'present' ? 1 : input.status === 'half_day' ? 0.5 : 0;
  return {
    dayValue: round2(rate.times(factor)).toFixed(2),
    overtimeValue: round2(
      new Dec(input.overtimeHours).times(rate.div(8)).times(input.multiplier),
    ).toFixed(2),
  };
}

/**
 * BR-6: divides an amount over fractions that add up to 1. Each line is rounded half-up to 2
 * decimals; when the rounded lines do not add up to the amount, the difference of a few cents is
 * moved, one cent at a time, to the lines that were rounded furthest in the opposite direction, so
 * the lines always add up to the amount exactly (AC-2).
 */
export function splitAmount(amount: string, fractions: readonly string[]): string[] {
  const total = new Dec(amount);
  const exact = fractions.map((fraction) => total.times(fraction));
  const cents = exact.map((value) => round2(value).times(100));
  let diff = total.times(100).minus(cents.reduce((sum, value) => sum.plus(value), new Dec(0)));
  const step = diff.isNegative() ? -1 : 1;
  // The lines that were rounded furthest the wrong way come first; ties keep their order.
  const order = exact
    .map((value, index) => ({ index, error: value.minus(round2(value)).times(step) }))
    .sort((a, b) => b.error.comparedTo(a.error) || a.index - b.index);
  for (let i = 0; !diff.isZero(); i = (i + 1) % order.length) {
    const line = order[i] as { index: number };
    cents[line.index] = (cents[line.index] as Decimal).plus(step);
    diff = diff.minus(step);
  }
  return cents.map((value) => value.div(100).toFixed(2));
}

export interface EntryAmounts {
  /** One amount per allocation, in order; overtime is part of the first one unless it has a project. */
  allocations: string[];
  /** The overtime of an entry whose overtime has its own project, otherwise null. */
  overtime: string | null;
}

/** BR-5, BR-6: what an entry costs on each of its projects. */
export function entryAmounts(entry: {
  allocations: readonly { fraction: string }[];
  overtimeProjectId: string | null;
  dayValue: string;
  overtimeValue: string;
}): EntryAmounts {
  const amounts = splitAmount(
    entry.dayValue,
    entry.allocations.map((a) => a.fraction),
  );
  const hasOvertime = new Dec(entry.overtimeValue).greaterThan(0);
  if (!hasOvertime) return { allocations: amounts, overtime: null };
  if (entry.overtimeProjectId !== null) {
    return { allocations: amounts, overtime: entry.overtimeValue };
  }
  return {
    allocations: amounts.map((amount, index) =>
      index === 0 ? new Dec(amount).plus(entry.overtimeValue).toFixed(2) : amount,
    ),
    overtime: null,
  };
}

/** The sum of money amounts, exact to the cent. */
export function sumAmounts(amounts: readonly string[]): string {
  return amounts.reduce((sum, amount) => sum.plus(amount), new Dec(0)).toFixed(2);
}

/** BR-6: idempotency keys of the cost entries of a sheet. */
export const allocationCostKey = (entryId: string, allocationId: string): string =>
  `att:${entryId}:${allocationId}`;
export const overtimeCostKey = (entryId: string): string => `att:${entryId}:ot`;

const MAX_PERIOD_DAYS = 93;

/**
 * BR-9: the weekdays (Monday to Friday) from `from` to `to`, never later than `today`, that are not
 * site holidays. The setting `site_holidays` is a comma-separated list of yyyy-mm-dd dates.
 */
export function workingDates(from: string, to: string, today: string, holidaysText: string) {
  const start = BusinessDate.parse(from);
  const last = BusinessDate.parse(to);
  if (start.isAfter(last)) {
    throw new ValidationError('period_invalid', 'The period ends before it starts');
  }
  if (last.daysSince(start) >= MAX_PERIOD_DAYS) {
    throw new ValidationError('period_too_long', 'The period is limited to three months');
  }
  const holidays = new Set(parseSiteHolidays(holidaysText));
  const limit = BusinessDate.parse(today);
  const dates: string[] = [];
  for (let day = start; !day.isAfter(last) && !day.isAfter(limit); day = day.addDays(1)) {
    const text = day.toString();
    const weekday = new Date(`${text}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(text)) dates.push(text);
  }
  return dates;
}
