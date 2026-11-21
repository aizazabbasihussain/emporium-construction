import { RuleViolationError } from '../errors.js';
import { Money } from '../kernel/money.js';

export type BillStatus =
  | 'draft'
  | 'matched'
  | 'pending_approval'
  | 'approved'
  | 'posted'
  | 'partly_paid'
  | 'paid'
  | 'cancelled';

export type PaymentStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'cancelled';

/**
 * Constitution 5.8: the allowed bill transitions. A bill returns to `matched` when its approval is
 * refused; payments move a posted bill between `posted`, `partly_paid` and `paid` in both directions
 * (a cancelled payment takes its allocation back).
 */
export const billTransitions: Record<BillStatus, readonly BillStatus[]> = {
  draft: ['matched', 'cancelled'],
  matched: ['pending_approval', 'draft', 'cancelled'],
  pending_approval: ['approved', 'matched'],
  approved: ['posted', 'cancelled'],
  posted: ['partly_paid', 'paid', 'cancelled'],
  partly_paid: ['partly_paid', 'paid', 'posted'],
  paid: ['partly_paid', 'posted'],
  cancelled: [],
};

export const paymentTransitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  draft: ['pending_approval', 'approved', 'cancelled'],
  pending_approval: ['approved', 'draft', 'cancelled'],
  approved: ['paid', 'cancelled'],
  paid: ['cancelled'],
  cancelled: [],
};

export function assertBillTransition(from: BillStatus, to: BillStatus): void {
  if (!billTransitions[from].includes(to)) {
    throw new RuleViolationError('bill_transition', `A ${from} bill cannot become ${to}`);
  }
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!paymentTransitions[from].includes(to)) {
    throw new RuleViolationError('payment_transition', `A ${from} payment cannot become ${to}`);
  }
}

/** BR-7: the status of a posted bill from what has been allocated to it. */
export function billStatusAfterPayments(gross: string, allocated: string): BillStatus {
  const paid = Money.of(allocated);
  if (paid.isZero() || paid.isNegative()) return 'posted';
  return paid.compare(Money.of(gross)) >= 0 ? 'paid' : 'partly_paid';
}
