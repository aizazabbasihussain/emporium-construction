import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { normalizeAmount } from './ledger.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** BR-2 and constitution 9.3: a government project needs the Pakistan-hosted environment flag. */
export function assertSectorAllowed(sector: string, allowGovernmentData: boolean): void {
  if (sector === 'government' && !allowGovernmentData) {
    throw new RuleViolationError(
      'government_data_not_allowed',
      'Government projects cannot be created in this environment',
    );
  }
}

/** BR-3: a manual project needs a positive contract value. */
export function normalizeContractValue(text: string): string {
  const value = normalizeAmount(text);
  if (!new Dec(value).greaterThan(0)) {
    throw new ValidationError('contract_value_not_positive', 'The contract value must be positive');
  }
  return value;
}

export interface CostLineInput {
  costCodeId: string;
  amount: string;
}

/**
 * BR-1: budget lines are the estimate's company-cost lines grouped by cost code, in the order the
 * codes first appear. A code whose lines add up to nothing (for example salvage credits only)
 * gets no line.
 */
export function budgetFromCostLines(lines: readonly CostLineInput[]): CostLineInput[] {
  const totals = new Map<string, Decimal>();
  for (const line of lines) {
    totals.set(line.costCodeId, (totals.get(line.costCodeId) ?? new Dec(0)).plus(line.amount));
  }
  return [...totals]
    .filter(([, total]) => total.greaterThan(0))
    .map(([costCodeId, total]) => ({ costCodeId, amount: total.toFixed(2) }));
}

/** BR-9: an assignment ends on or after the day it starts. */
export function assertAssignmentDates(from: string, to: string | null): void {
  if (to !== null && to < from) {
    throw new ValidationError('assignment_dates_invalid', 'The end date is before the start date');
  }
}

/** BR-9: an assignment holds the project scope until its end date; on that day it has ended. */
export function isAssignmentOpen(to: string | null, today: string): boolean {
  return to === null || to > today;
}
