import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/business-date.js';
import { Money, Percent } from '../kernel/money.js';

export const advanceRecoveryMethods = ['proportional', 'fixed_percent'] as const;
export type AdvanceRecoveryMethod = (typeof advanceRecoveryMethods)[number];

export function assertRecoveryMethod(value: string): AdvanceRecoveryMethod {
  if (!(advanceRecoveryMethods as readonly string[]).includes(value)) {
    throw new ValidationError(
      'invalid_recovery_method',
      'The advance recovery method must be proportional or fixed_percent',
    );
  }
  return value as AdvanceRecoveryMethod;
}

export interface RecoveryInput {
  method: AdvanceRecoveryMethod;
  /** Advance received and not yet applied. */
  unapplied: string;
  /** The base of this invoice. */
  invoiceBase: string;
  /** Contract value still unbilled before this invoice (the planned stages). */
  remainingUnbilled: string;
  /** Used by `fixed_percent`. */
  fixedPercent: string;
}

/**
 * BR-3 (H-28): the part of the unapplied advance this invoice takes back. Proportional recovery is
 * unapplied x (invoice base / remaining unbilled); the alternative takes a fixed percent of the
 * base. Either way it never exceeds the unapplied advance or the invoice base. Half-up to 2 decimals.
 */
export function advanceRecovery(input: RecoveryInput): string {
  const unapplied = Money.of(input.unapplied);
  const base = Money.of(input.invoiceBase);
  if (!unapplied.value.gt(0) || !base.value.gt(0)) return Money.zero().toString();
  let raw: Decimal;
  if (input.method === 'proportional') {
    const remaining = Money.of(input.remainingUnbilled);
    // Nothing left unbilled means this invoice closes the schedule: the whole advance comes back.
    raw = remaining.value.gt(0)
      ? unapplied.value.times(base.value).div(remaining.value)
      : unapplied.value;
  } else {
    const percent = Percent.of(input.fixedPercent);
    if (percent.isNegative() || percent.value.gt(100)) {
      throw new ValidationError(
        'invalid_recovery_percent',
        'The recovery percent must be 0 to 100',
      );
    }
    raw = base.value.times(percent.value).div(100);
  }
  return Money.of(Decimal.min(Money.of(raw).value, unapplied.value, base.value)).toString();
}

/** BR-3: the base that tax is charged on. Tax charged at receipt means the full base is taxed. */
export function taxableBase(base: string, recovery: string, taxAtReceipt: boolean): string {
  return (taxAtReceipt ? Money.of(base) : Money.of(base).sub(Money.of(recovery))).toString();
}

/**
 * BR-4: taxable base plus tax; when tax was charged at receipt the recovery is a deduction line
 * (the client already paid that part with the advance invoice).
 */
export function grossTotal(
  taxable: string,
  tax: string,
  recovery: string,
  taxAtReceipt: boolean,
): string {
  const sum = Money.of(taxable).add(Money.of(tax));
  return (taxAtReceipt ? sum.sub(Money.of(recovery)) : sum).toString();
}

/**
 * BR-7: net billed (invoice bases less advance recovery, credit notes taken off) plus the new
 * invoice may not exceed the contract value.
 */
export function assertWithinContract(input: {
  contractValue: string;
  netBilled: string;
  adding: string;
}): void {
  const total = Money.of(input.netBilled).add(Money.of(input.adding));
  if (total.compare(Money.of(input.contractValue)) > 0) {
    throw new RuleViolationError(
      'contract_exceeded',
      `Billing ${total.toString()} would exceed the contract value ${Money.of(input.contractValue).toString()}`,
    );
  }
}

/**
 * BR-3: spreads a recovery that reduces the taxable base over the invoice lines in proportion to
 * their amounts (half-up); the last line takes the rounding difference so the parts add up exactly.
 */
export function spreadReduction(amounts: readonly string[], reduction: string): string[] {
  const values = amounts.map((amount) => Money.of(amount));
  const total = values.reduce((sum, value) => sum.add(value), Money.zero());
  const whole = Money.of(reduction);
  let left = whole;
  return values.map((value, index) => {
    const isLast = index === values.length - 1;
    const share =
      isLast || total.isZero() ? left : Money.of(whole.value.times(value.value).div(total.value));
    left = left.sub(share);
    return value.sub(share).toString();
  });
}

/** BR-10: due date = invoice date + payment days. */
export function dueDateOf(invoiceDate: string, days: number): string {
  return BusinessDate.parse(invoiceDate).addDays(days).toString();
}

/** The series for an authority is `invoice_<authority>` when one exists, else the shared one (H-04). */
export function invoiceSeriesFor(
  authorityCode: string,
  existing: readonly string[],
  shared: string,
): string {
  const own = `${shared}_${authorityCode.toLowerCase()}`;
  return existing.includes(own) ? own : shared;
}
