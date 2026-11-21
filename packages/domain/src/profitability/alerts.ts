import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/index.js';
import type { Financials } from './financials.js';

export const alertCodes = ['margin_below_floor', 'overspend', 'receivable_overdue'] as const;
export type AlertCode = (typeof alertCodes)[number];

export interface Thresholds {
  marginFloorPercent: string;
  overspendPercent: string;
  receivableAgeDays: number;
}

/** BR-4: the project's own thresholds when it has active ones, else the company's, else none. */
export function pickThresholds<T extends { scope: string; projectId: string | null }>(
  rows: readonly T[],
  projectId: string,
): T | null {
  return (
    rows.find((row) => row.scope === 'project' && row.projectId === projectId) ??
    rows.find((row) => row.scope === 'company') ??
    null
  );
}

const over = (value: string | null, limit: string): boolean =>
  value !== null && new Decimal(value).greaterThan(new Decimal(limit));

/** Whole days from `from` to `to` (both business dates). */
export function daysBetween(from: string, to: string): number {
  const ms = (day: string): number => {
    const [y, m, d] = BusinessDate.parse(day).toString().split('-').map(Number) as [
      number,
      number,
      number,
    ];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/**
 * BR-4: which alert conditions are true now. A margin that cannot be computed (no contract value)
 * and a budget of zero raise nothing.
 */
export function evaluateAlerts(input: {
  financials: Pick<Financials, 'expectedMarginPercent' | 'costPercentOfBudget'>;
  thresholds: Thresholds | null;
  /** The oldest due date among invoices that still owe money; null when none. */
  oldestDueDate: string | null;
  asOf: string;
}): AlertCode[] {
  const { financials, thresholds, oldestDueDate, asOf } = input;
  if (thresholds === null) return [];
  const raised: AlertCode[] = [];
  const margin = financials.expectedMarginPercent;
  if (margin !== null && new Decimal(margin).lessThan(new Decimal(thresholds.marginFloorPercent))) {
    raised.push('margin_below_floor');
  }
  if (over(financials.costPercentOfBudget, thresholds.overspendPercent)) raised.push('overspend');
  if (oldestDueDate !== null && daysBetween(oldestDueDate, asOf) > thresholds.receivableAgeDays) {
    raised.push('receivable_overdue');
  }
  return raised;
}

/** BR-4: an alert is raised once and cleared when its condition no longer holds. */
export function alertChanges(
  active: readonly AlertCode[],
  now: readonly AlertCode[],
): { raise: AlertCode[]; clear: AlertCode[] } {
  return {
    raise: now.filter((code) => !active.includes(code)),
    clear: active.filter((code) => !now.includes(code)),
  };
}

export function assertThresholds(input: {
  marginFloorPercent: string;
  overspendPercent: string;
  receivableAgeDays: number;
}): void {
  const percent = (value: string, field: string, max: number | null) => {
    if (!/^-?\d+(\.\d{1,4})?$/.test(value)) {
      throw new ValidationError('invalid_threshold', `${field} must be a number`);
    }
    if (max !== null && (new Decimal(value).lessThan(0) || new Decimal(value).greaterThan(max))) {
      throw new ValidationError('invalid_threshold', `${field} must be between 0 and ${max}`);
    }
  };
  percent(input.marginFloorPercent, 'marginFloorPercent', 100);
  percent(input.overspendPercent, 'overspendPercent', 1000);
  if (!Number.isInteger(input.receivableAgeDays) || input.receivableAgeDays < 0) {
    throw new ValidationError('invalid_threshold', 'receivableAgeDays must be zero or more days');
  }
}

/** BR-5: more active alerts first, then the lower expected margin, then the lower cash position. */
export function compareRisk(
  a: { alerts: number; expectedMarginPercent: string | null; cashPosition: string },
  b: { alerts: number; expectedMarginPercent: string | null; cashPosition: string },
): number {
  if (a.alerts !== b.alerts) return b.alerts - a.alerts;
  if (a.expectedMarginPercent !== b.expectedMarginPercent) {
    if (a.expectedMarginPercent === null) return 1;
    if (b.expectedMarginPercent === null) return -1;
    return new Decimal(a.expectedMarginPercent).comparedTo(new Decimal(b.expectedMarginPercent));
  }
  return new Decimal(a.cashPosition).comparedTo(new Decimal(b.cashPosition));
}
