import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { Money } from '../kernel/money.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const smaller = (a: Money, b: Money): Money => (a.compare(b) > 0 ? b : a);

/** BR-4: net payable is the gross total less the withholding we deduct. */
export function billFigures(input: { gross: string; withholdingTotal: string }): {
  gross: string;
  withholdingTotal: string;
  netPayable: string;
} {
  const gross = Money.of(input.gross);
  const withholding = Money.of(input.withholdingTotal);
  if (withholding.isNegative() || withholding.compare(gross) > 0) {
    throw new RuleViolationError(
      'withholding_invalid',
      'Withholding cannot be negative or above the gross total',
    );
  }
  return {
    gross: gross.toString(),
    withholdingTotal: withholding.toString(),
    netPayable: gross.sub(withholding).toString(),
  };
}

export interface BillOpenFigures {
  billId: string;
  gross: string;
  withholdingTotal: string;
  /** Gross already allocated by payments that count. */
  allocated: string;
  /** Withholding already deducted by those payments. */
  withheld: string;
}

export interface PaymentAllocation {
  billId: string;
  /** In gross terms: cash paid plus the withholding deducted on this bill. */
  amount: string;
}

export interface PaymentAllocationResult {
  billId: string;
  amount: string;
  withholding: string;
}

/**
 * BR-7: the allocations of one payment. Each bill takes at most what it still owes, the withholding
 * deducted is the bill's share (the rest of it when the bill is settled in full), and the cash paid is
 * the allocations less that withholding.
 */
export function allocatePayment(
  allocations: readonly PaymentAllocation[],
  bills: readonly BillOpenFigures[],
): { lines: PaymentAllocationResult[]; withholdingDeducted: string; amount: string } {
  if (allocations.length === 0) {
    throw new ValidationError('allocation_required', 'A payment is allocated to at least one bill');
  }
  const seen = new Set<string>();
  let total = Money.zero();
  let withheld = Money.zero();
  const lines = allocations.map((line): PaymentAllocationResult => {
    const amount = Money.of(line.amount);
    if (amount.isNegative() || amount.isZero()) {
      throw new ValidationError('allocation_invalid', 'Each allocation must be above zero');
    }
    if (seen.has(line.billId)) {
      throw new ValidationError('allocation_duplicate', 'A bill appears once in a payment');
    }
    seen.add(line.billId);
    const bill = bills.find((b) => b.billId === line.billId);
    if (bill === undefined) {
      throw new RuleViolationError('bill_not_payable', `Bill ${line.billId} cannot be paid`);
    }
    const outstanding = Money.of(bill.gross).sub(Money.of(bill.allocated));
    if (amount.compare(outstanding) > 0) {
      throw new RuleViolationError(
        'over_allocation',
        `Bill ${line.billId} cannot take ${amount.toString()}`,
      );
    }
    const remaining = Money.of(bill.withholdingTotal).sub(Money.of(bill.withheld));
    const share = amount.equals(outstanding)
      ? remaining
      : smaller(
          Money.of(
            new Dec(bill.withholdingTotal).times(amount.toString()).div(bill.gross).toFixed(10),
          ),
          remaining,
        );
    total = total.add(amount);
    withheld = withheld.add(share);
    return { billId: line.billId, amount: amount.toString(), withholding: share.toString() };
  });
  return {
    lines,
    withholdingDeducted: withheld.toString(),
    amount: total.sub(withheld).toString(),
  };
}

export interface BalanceBill {
  netPayable: string;
  withholdingTotal: string;
}

/**
 * BR-9: posted bills' net payable plus the withholding payable (shown apart) less the payments
 * allocated (gross terms). Cancelled bills and payments are not passed in.
 */
export function vendorBalance(input: {
  bills: readonly BalanceBill[];
  allocated: readonly string[];
}): { netPayable: string; withholdingPayable: string; payments: string; balance: string } {
  const sum = (values: readonly string[]) =>
    values.reduce((s, v) => s.add(Money.of(v)), Money.zero());
  const net = sum(input.bills.map((b) => b.netPayable));
  const withholding = sum(input.bills.map((b) => b.withholdingTotal));
  const payments = sum(input.allocated);
  return {
    netPayable: net.toString(),
    withholdingPayable: withholding.toString(),
    payments: payments.toString(),
    balance: net.add(withholding).sub(payments).toString(),
  };
}

/** BR-11: bills grouped by vendor, vendors in first-seen order, bills keeping their order. */
export function groupByVendor<T extends { vendorPartyId: string }>(
  bills: readonly T[],
): { vendorPartyId: string; bills: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const bill of bills) {
    groups.set(bill.vendorPartyId, [...(groups.get(bill.vendorPartyId) ?? []), bill]);
  }
  return [...groups.entries()].map(([vendorPartyId, list]) => ({ vendorPartyId, bills: list }));
}

/** BR-8: the month a withholding deduction is reported in. */
export const withholdingMonth = (date: string): string => date.slice(0, 7);

/** BR-7: a cheque dated after the payment posts to the cash book on its date, not before. */
export function chequeIsPostDated(
  method: string,
  chequeDate: string | null,
  paymentDate: string,
): boolean {
  return method === 'cheque' && chequeDate !== null && chequeDate > paymentDate;
}
