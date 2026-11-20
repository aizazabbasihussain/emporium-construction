import { RuleViolationError, ValidationError } from '../errors.js';
import { Money } from '../kernel/money.js';

export type AllocationKind = 'invoice' | 'advance' | 'withholding';

export interface AllocationInput {
  kind: AllocationKind;
  invoiceId: string;
  advanceId?: string | undefined;
  amount: string;
}

export interface OpenItem {
  invoiceId: string;
  dueDate: string;
  /** What may still be allocated (outstanding less cheques still in hand). */
  allocatable: string;
}

/**
 * BR-3: the allocations add up to the receipt plus what the client withheld, withholding lines add
 * up to the withheld amount, and no invoice receives more than it still owes.
 */
export function validateAllocations(input: {
  receiptAmount: string;
  withheldAmount: string;
  allocations: readonly AllocationInput[];
  allocatable: ReadonlyMap<string, string>;
}): void {
  const cash = Money.of(input.receiptAmount);
  const withheld = Money.of(input.withheldAmount);
  if (cash.isNegative() || cash.isZero()) {
    throw new ValidationError('amount_invalid', 'The receipt amount must be above zero');
  }
  if (withheld.isNegative()) {
    throw new ValidationError('withheld_invalid', 'The withheld amount cannot be negative');
  }
  const perInvoice = new Map<string, Money>();
  let total = Money.zero();
  let withholdingTotal = Money.zero();
  for (const line of input.allocations) {
    const amount = Money.of(line.amount);
    if (amount.isNegative() || amount.isZero()) {
      throw new ValidationError('allocation_invalid', 'Each allocation must be above zero');
    }
    if (line.kind === 'advance' && line.advanceId === undefined) {
      throw new ValidationError('advance_required', 'An advance allocation names the advance');
    }
    total = total.add(amount);
    if (line.kind === 'withholding') withholdingTotal = withholdingTotal.add(amount);
    perInvoice.set(line.invoiceId, (perInvoice.get(line.invoiceId) ?? Money.zero()).add(amount));
  }
  if (!total.equals(cash.add(withheld))) {
    throw new RuleViolationError(
      'allocation_sum_mismatch',
      `Allocations total ${total.toString()} but the receipt and withholding total ${cash.add(withheld).toString()}`,
    );
  }
  if (!withholdingTotal.equals(withheld)) {
    throw new RuleViolationError(
      'withholding_allocation_mismatch',
      'Withholding allocations must add up to the withheld amount',
    );
  }
  for (const [invoiceId, amount] of perInvoice) {
    const room = input.allocatable.get(invoiceId);
    if (room === undefined || amount.compare(Money.of(room)) > 0) {
      throw new RuleViolationError(
        'over_allocation',
        `Invoice ${invoiceId} cannot take ${amount.toString()}`,
      );
    }
  }
}

/** BR-3: oldest due date first (the invoice id breaks ties); returns the suggestion, not a booking. */
export function suggestAllocation(
  amount: string,
  items: readonly OpenItem[],
): { invoiceId: string; amount: string }[] {
  let left = Money.of(amount);
  const out: { invoiceId: string; amount: string }[] = [];
  const ordered = [...items].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceId.localeCompare(b.invoiceId),
  );
  for (const item of ordered) {
    if (left.isZero()) break;
    const room = Money.of(item.allocatable);
    if (room.isZero() || room.isNegative()) continue;
    const take = room.compare(left) < 0 ? room : left;
    out.push({ invoiceId: item.invoiceId, amount: take.toString() });
    left = left.sub(take);
  }
  return out;
}

export interface WithholdingCheck {
  expected: string;
  actual: string;
  difference: string;
  flagged: boolean;
}

/** BR-4: the difference is flagged above the tolerance; it never blocks. */
export function checkWithholding(
  expected: string,
  actual: string,
  tolerance: string,
): WithholdingCheck {
  const difference = Money.of(actual).sub(Money.of(expected));
  const size = difference.isNegative() ? difference.negate() : difference;
  return {
    expected: Money.of(expected).toString(),
    actual: Money.of(actual).toString(),
    difference: difference.toString(),
    flagged: size.compare(Money.of(tolerance)) > 0,
  };
}

/** BR-1: gross less credit notes, allocated receipts, allocated withholding and adjustments. */
export function invoiceOutstanding(input: {
  gross: string;
  credited: string;
  allocated: string;
  adjusted: string;
}): string {
  return Money.of(input.gross)
    .sub(Money.of(input.credited))
    .sub(Money.of(input.allocated))
    .sub(Money.of(input.adjusted))
    .toString();
}

/** BR-11: a balance may be written off when it is positive and within the limit. */
export function assertWriteOffAllowed(outstanding: string, amount: string, limit: string): void {
  const value = Money.of(amount);
  if (value.isNegative() || value.isZero()) {
    throw new ValidationError('amount_invalid', 'The write-off must be above zero');
  }
  if (value.compare(Money.of(limit)) > 0) {
    throw new RuleViolationError(
      'write_off_above_limit',
      `A write-off is limited to ${Money.of(limit).toString()}`,
    );
  }
  if (value.compare(Money.of(outstanding)) > 0) {
    throw new RuleViolationError('write_off_above_balance', 'The write-off exceeds the balance');
  }
}
