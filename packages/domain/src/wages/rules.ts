import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import type { EntryStatus } from '../attendance/rules.js';

// Pure wage rules (spec P1-18 section 4). Nothing here touches a database. Money is computed with
// Decimal at 40 digits and rounded half-up to 2 decimals per component (constitution 5.4, BR-7).

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const periodStatuses = ['draft', 'calculated', 'submitted', 'approved', 'reopened'] as const;
export type PeriodStatus = (typeof periodStatuses)[number];

/**
 * Constitution 5.8, BR-8, BR-11: the allowed period transitions as an explicit table. Calculating
 * again leaves a calculated or reopened period where it is; only a draft becomes calculated. A
 * period whose approval request is rejected, returned or withdrawn goes back to calculated.
 */
export const periodTransitions: Record<PeriodStatus, readonly PeriodStatus[]> = {
  draft: ['calculated'],
  calculated: ['submitted'],
  submitted: ['approved', 'calculated'],
  approved: ['reopened'],
  reopened: ['submitted'],
};

export function assertPeriodTransition(from: PeriodStatus, to: PeriodStatus): void {
  if (!periodTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'period_transition',
      `A wage period cannot go from ${from} to ${to}`,
    );
  }
}

/** BR-8: an approved period is refused (reopen it first); a submitted one is with the approver. */
export function assertCalculable(status: PeriodStatus): void {
  if (status === 'approved') {
    throw new RuleViolationError(
      'period_approved',
      'The wage period is approved; reopen it before calculating again',
    );
  }
  if (status === 'submitted') {
    throw new RuleViolationError(
      'period_submitted',
      'The wage period is with the approver and cannot be calculated again',
    );
  }
}

/** BR-10: adjustments are added only while the period is calculated or reopened. */
export function assertAdjustable(status: PeriodStatus): void {
  if (status !== 'calculated' && status !== 'reopened') {
    throw new RuleViolationError(
      'period_not_adjustable',
      'Allowances and deductions can be added only while the period is calculated or reopened',
    );
  }
}

export interface MonthBounds {
  from: string;
  to: string;
}

/** The first and last calendar day of a month. */
export function monthBounds(year: number, month: number): MonthBounds {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ValidationError('period_year_invalid', 'The year must be between 2000 and 2100');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValidationError('period_month_invalid', 'The month must be between 1 and 12');
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const text = `${year}-${String(month).padStart(2, '0')}`;
  return { from: `${text}-01`, to: `${text}-${String(last).padStart(2, '0')}` };
}

/** Half-up to 2 decimals. */
export const money = (value: Decimal.Value): string =>
  new Dec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export const sumMoney = (values: readonly Decimal.Value[]): string =>
  money(values.reduce<Decimal>((total, value) => total.plus(value), new Dec(0)));

export interface WageSettings {
  /** H-11: the working days a monthly salary is divided by. */
  workingDaysBasis: number;
  /** H-11: overtime is paid at this multiple of the hourly rate (daily-equivalent / 8). */
  overtimeMultiplier: string;
  /** BR-2: daily-rate workers are paid for off days and paid leave. */
  payOffDaysDaily: boolean;
  /** BR-7, H-11: net pay is rounded to the nearest rupee. */
  roundNetToRupee: boolean;
}

export function assertWageSettings(settings: WageSettings): void {
  if (!Number.isInteger(settings.workingDaysBasis) || settings.workingDaysBasis < 1) {
    throw new RuleViolationError(
      'working_days_basis_not_set',
      'The working-days basis of a month is not set',
    );
  }
  if (
    !/^\d{1,2}(\.\d{1,4})?$/.test(settings.overtimeMultiplier.trim()) ||
    new Dec(settings.overtimeMultiplier).lte(0)
  ) {
    throw new RuleViolationError(
      'overtime_multiplier_invalid',
      'The overtime multiplier setting is not a positive number',
    );
  }
}

export type PayBasis = 'daily_rate' | 'monthly_salary';

/** One approved attendance day of a worker with the pay rate in effect on that day. */
export interface DayInput {
  date: string;
  status: EntryStatus;
  overtimeHours: string;
  payBasis: PayBasis;
  /** The daily rate, or the monthly salary, in effect on the day. */
  amount: string;
  /** The pay for one day on that date (workforce `dailyEquivalent`). */
  dailyEquivalent: string;
}

export interface BasicPay {
  payBasis: PayBasis;
  rate: string;
  presentDays: string;
  halfDays: string;
  paidLeaveDays: string;
  offDays: string;
  absentDays: string;
  overtimeHours: string;
  basicPay: string;
  overtimePay: string;
}

/** BR-2, BR-3: the share of a day that is paid for a status. */
export function payableFraction(
  status: EntryStatus,
  payBasis: PayBasis,
  payOffDaysDaily: boolean,
): Decimal {
  switch (status) {
    case 'present':
      return new Dec(1);
    case 'half_day':
      return new Dec('0.5');
    case 'leave_paid':
    case 'off':
      return payBasis === 'monthly_salary' || payOffDaysDaily ? new Dec(1) : new Dec(0);
    default:
      return new Dec(0);
  }
}

/**
 * BR-1 to BR-4: basic and overtime pay from the approved days of one worker. A daily rate pays each
 * paid day at the rate in effect that day. A monthly salary pays salary / basis per payable day at
 * the salary in effect that day, and the payable days are capped at the basis (the capped part is
 * scaled down proportionally). Overtime is hours x (daily-equivalent / 8) x multiplier per day.
 * Each component is rounded once, half-up, at the end.
 */
export function calculateBasicPay(days: readonly DayInput[], settings: WageSettings): BasicPay {
  assertWageSettings(settings);
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const basis = new Dec(settings.workingDaysBasis);
  const multiplier = new Dec(settings.overtimeMultiplier);
  let daily = new Dec(0);
  let monthly = new Dec(0);
  let monthlyDays = new Dec(0);
  let overtime = new Dec(0);
  let hours = new Dec(0);
  const count = { present: 0, half_day: 0, leave_paid: 0, off: 0, absent: 0 };
  for (const day of ordered) {
    const fraction = payableFraction(day.status, day.payBasis, settings.payOffDaysDaily);
    if (day.payBasis === 'daily_rate') {
      daily = daily.plus(fraction.times(day.amount));
    } else {
      monthly = monthly.plus(fraction.times(day.amount).div(basis));
      monthlyDays = monthlyDays.plus(fraction);
    }
    overtime = overtime.plus(
      new Dec(day.overtimeHours).times(day.dailyEquivalent).div(8).times(multiplier),
    );
    hours = hours.plus(day.overtimeHours);
    if (day.status === 'present') count.present += 1;
    else if (day.status === 'half_day') count.half_day += 1;
    else if (day.status === 'leave_paid') count.leave_paid += 1;
    else if (day.status === 'off') count.off += 1;
    else count.absent += 1;
  }
  if (monthlyDays.gt(basis)) monthly = monthly.times(basis).div(monthlyDays);
  const last = ordered[ordered.length - 1] as DayInput;
  return {
    payBasis: last.payBasis,
    rate: new Dec(last.amount).toFixed(2),
    presentDays: new Dec(count.present).toFixed(2),
    halfDays: new Dec(count.half_day).toFixed(2),
    paidLeaveDays: new Dec(count.leave_paid).toFixed(2),
    offDays: new Dec(count.off).toFixed(2),
    absentDays: new Dec(count.absent).toFixed(2),
    overtimeHours: hours.toFixed(2),
    basicPay: money(daily.plus(monthly)),
    overtimePay: money(overtime),
  };
}

export interface OpenAdvance {
  id: string;
  /** The most the worker repays per month. */
  monthlyRecovery: string;
  /** What is still owed: the amount less the recoveries of approved periods. */
  balance: string;
}

export interface SettleInput {
  basicPay: string;
  overtimePay: string;
  /** Manual allowances and deductions of the line (BR-10). */
  allowances: string;
  deductions: string;
  /** The open advances of the worker, oldest first. */
  advances: readonly OpenAdvance[];
  roundNetToRupee: boolean;
}

export interface Settlement {
  grossPay: string;
  deductions: string;
  advanceRecovery: string;
  recoveries: { advanceId: string; amount: string }[];
  /** BR-5: deductions beyond the gross pay, left for a manual decision. */
  shortfall: string;
  netPay: string;
  roundingAdjustment: string;
}

/**
 * BR-5 to BR-7: gross, advance recovery and net pay. The recovery of each advance is the least of
 * its monthly instalment, its open balance and what is left of the gross after deductions, so the
 * recovery is the part that gives way first (the rest stays on the balance and is carried to the
 * next month). Net pay never goes below zero: deductions beyond the gross are reported as the
 * shortfall. Net pay is rounded to the nearest rupee when asked and the difference is kept.
 */
export function settleLine(input: SettleInput): Settlement {
  const gross = new Dec(input.basicPay).plus(input.overtimePay).plus(input.allowances);
  const deductions = new Dec(input.deductions);
  const headroom = Decimal.max(gross.minus(deductions), 0);
  let left = headroom;
  const recoveries: Settlement['recoveries'] = [];
  for (const advance of input.advances) {
    const amount = Decimal.min(advance.monthlyRecovery, advance.balance, left);
    if (amount.lte(0)) continue;
    left = left.minus(amount);
    recoveries.push({ advanceId: advance.id, amount: money(amount) });
  }
  const recovery = recoveries.reduce((total, item) => total.plus(item.amount), new Dec(0));
  const shortfall = Decimal.max(deductions.minus(gross), 0);
  const exact = gross.minus(deductions).minus(recovery).plus(shortfall);
  const net = input.roundNetToRupee ? exact.toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : exact;
  return {
    grossPay: money(gross),
    deductions: money(deductions),
    advanceRecovery: money(recovery),
    recoveries,
    shortfall: money(shortfall),
    netPay: money(net),
    roundingAdjustment: money(net.minus(exact)),
  };
}

export interface LineAmounts {
  basicPay: string;
  overtimePay: string;
  allowances: string;
  deductions: string;
  advanceRecovery: string;
  grossPay: string;
  netPay: string;
  roundingAdjustment: string;
}

/** The totals of a period: every amount summed over its lines. */
export function periodTotals(lines: readonly LineAmounts[]): LineAmounts {
  const total = (pick: (line: LineAmounts) => string) => sumMoney(lines.map(pick));
  return {
    basicPay: total((l) => l.basicPay),
    overtimePay: total((l) => l.overtimePay),
    allowances: total((l) => l.allowances),
    deductions: total((l) => l.deductions),
    advanceRecovery: total((l) => l.advanceRecovery),
    grossPay: total((l) => l.grossPay),
    netPay: total((l) => l.netPay),
    roundingAdjustment: total((l) => l.roundingAdjustment),
  };
}

/** BR-10: an allowance or deduction is an amount above zero with at most 2 decimals. */
export function assertAdjustmentAmount(amount: string): string {
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(amount.trim()) || new Dec(amount).lte(0)) {
    throw new ValidationError('adjustment_amount_invalid', 'The amount must be greater than zero');
  }
  return money(amount);
}

/** BR-10, BR-11: a reason is required. */
export function assertReason(reason: string): string {
  const text = reason.trim();
  if (text === '') throw new ValidationError('reason_required', 'A reason is required');
  return text;
}

export interface AdvanceInput {
  amount: string;
  monthlyRecovery: string;
}

/** An advance and its monthly instalment are amounts above zero; the instalment is at most the advance. */
export function assertAdvance(input: AdvanceInput): { amount: string; monthlyRecovery: string } {
  const pattern = /^\d{1,16}(\.\d{1,2})?$/;
  if (!pattern.test(input.amount.trim()) || new Dec(input.amount).lte(0)) {
    throw new ValidationError('advance_amount_invalid', 'The advance must be greater than zero');
  }
  if (!pattern.test(input.monthlyRecovery.trim()) || new Dec(input.monthlyRecovery).lte(0)) {
    throw new ValidationError(
      'advance_recovery_invalid',
      'The monthly recovery must be greater than zero',
    );
  }
  if (new Dec(input.monthlyRecovery).gt(input.amount)) {
    throw new ValidationError(
      'advance_recovery_invalid',
      'The monthly recovery cannot be more than the advance',
    );
  }
  return { amount: money(input.amount), monthlyRecovery: money(input.monthlyRecovery) };
}

export interface UnapprovedSheetRef {
  teamId: string;
  date: string;
}

export interface SubmissionCheck {
  /** Attendance sheets of the month that are not approved. */
  unapproved: readonly UnapprovedSheetRef[];
  /** Team-days of the month with no sheet at all. */
  missing: readonly UnapprovedSheetRef[];
  /** Workers whose deductions are more than their gross pay. */
  shortfalls: readonly string[];
  acknowledged: boolean;
}

/**
 * BR-9, BR-5: unapproved sheets block submission and are listed in the error; days with no sheet
 * and shortfalls are warnings the approver acknowledges.
 */
export function assertSubmissionReady(check: SubmissionCheck): void {
  if (check.unapproved.length > 0) {
    const list = check.unapproved.map((sheet) => `${sheet.date} (team ${sheet.teamId})`).join(', ');
    throw new RuleViolationError(
      'unapproved_attendance',
      `Attendance sheets not yet approved: ${list}`,
    );
  }
  if ((check.missing.length > 0 || check.shortfalls.length > 0) && !check.acknowledged) {
    throw new RuleViolationError(
      'warnings_not_acknowledged',
      'The warnings (days with no sheet, deductions above pay) must be acknowledged to submit',
    );
  }
}

export interface ReconciliationRow {
  workerId: string;
  /** Labour cost the approved attendance allocated to projects. */
  allocated: string;
  /** Gross pay of the wage sheet. */
  gross: string;
  /** Gross less allocated. */
  difference: string;
}

export interface Reconciliation {
  rows: ReconciliationRow[];
  /** The rows whose gross differs from the allocated cost. */
  differences: ReconciliationRow[];
  totals: { allocated: string; gross: string; difference: string };
}

/** BR-12: attendance-allocated cost against wage-sheet gross by worker and in total. */
export function reconcile(
  allocated: ReadonlyMap<string, string>,
  gross: ReadonlyMap<string, string>,
): Reconciliation {
  const ids = [...new Set([...allocated.keys(), ...gross.keys()])].sort();
  const rows = ids.map((workerId): ReconciliationRow => {
    const a = allocated.get(workerId) ?? '0';
    const g = gross.get(workerId) ?? '0';
    return {
      workerId,
      allocated: money(a),
      gross: money(g),
      difference: money(new Dec(g).minus(a)),
    };
  });
  const allocatedTotal = sumMoney(rows.map((row) => row.allocated));
  const grossTotal = sumMoney(rows.map((row) => row.gross));
  return {
    rows,
    differences: rows.filter((row) => !new Dec(row.difference).isZero()),
    totals: {
      allocated: allocatedTotal,
      gross: grossTotal,
      difference: money(new Dec(grossTotal).minus(allocatedTotal)),
    },
  };
}
