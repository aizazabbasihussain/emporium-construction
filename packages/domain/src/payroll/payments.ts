import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { sumMoney } from './spread.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface PayableLine {
  id: string;
  netPay: string;
}

export interface CashPlan {
  lineIds: string[];
  amount: string;
}

/**
 * BR-4: the cash book transactions of a payment: one for the whole selection (the line list goes
 * into the reference), or one per line when the setting `payroll_cash_txn_per_line` is on.
 */
export function planCashTransactions(lines: readonly PayableLine[], perLine: boolean): CashPlan[] {
  if (lines.length === 0) {
    throw new ValidationError('no_lines_selected', 'Select at least one unpaid line');
  }
  if (perLine) {
    return lines.map((line) => ({ lineIds: [line.id], amount: new Dec(line.netPay).toFixed(2) }));
  }
  return [{ lineIds: lines.map((line) => line.id), amount: sumMoney(lines.map((l) => l.netPay)) }];
}

/** BR-4: a payment above the approval band needs an approved request (the band is the cash book's). */
export function needsPaymentApproval(total: string, band: string): boolean {
  return new Dec(total).gt(band);
}

/** BR-4: the person who finalized the run cannot be among those who approved its payment. */
export function assertApproverIsNotFinalizer(
  approvers: readonly string[],
  finalizedBy: string | null,
): void {
  if (finalizedBy !== null && approvers.includes(finalizedBy)) {
    throw new RuleViolationError(
      'finalizer_cannot_approve',
      'The user who finalized the run cannot approve its payment',
    );
  }
}

/** BR-4: only lines of the run that are still unpaid can be paid. */
export function assertLinesPayable(
  selected: readonly string[],
  unpaid: readonly { id: string }[],
): void {
  if (selected.length === 0) {
    throw new ValidationError('no_lines_selected', 'Select at least one unpaid line');
  }
  const open = new Set(unpaid.map((line) => line.id));
  if (selected.some((id) => !open.has(id)) || new Set(selected).size !== selected.length) {
    throw new RuleViolationError(
      'line_not_payable',
      'Each selected line must be an unpaid line of this run, once',
    );
  }
}
