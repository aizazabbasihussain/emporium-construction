import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';
import { normalizeAmount, type StatusTotals } from './ledger.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type BudgetFlag = 'ok' | 'warning' | 'overspent';

export interface BudgetVariance {
  budget: string;
  spent: string;
  /** BR-8: budget - (committed + approved + posted); negative means overspend. */
  variance: string;
  flag: BudgetFlag;
}

/**
 * BR-8: overspend is flagged, never blocked; the warning starts when spending reaches the
 * configured share of the budget. Nothing spent is never a warning.
 */
export function budgetVariance(
  budget: string,
  totals: StatusTotals,
  warningPercent: number,
): BudgetVariance {
  const spent = new Dec(totals.committed).plus(totals.approved).plus(totals.posted);
  const variance = new Dec(budget).minus(spent);
  let flag: BudgetFlag = 'ok';
  if (variance.isNegative()) {
    flag = 'overspent';
  } else if (
    !spent.isZero() &&
    spent.times(100).greaterThanOrEqualTo(new Dec(budget).times(warningPercent))
  ) {
    flag = 'warning';
  }
  return {
    budget: new Dec(budget).toFixed(2),
    spent: spent.toFixed(2),
    variance: variance.toFixed(2),
    flag,
  };
}

/** A budget amount is a non-negative money value. */
export function normalizeBudgetAmount(text: string): string {
  const amount = normalizeAmount(text);
  if (new Dec(amount).isNegative()) {
    throw new ValidationError('budget_negative', 'A budget amount cannot be negative');
  }
  return amount;
}
