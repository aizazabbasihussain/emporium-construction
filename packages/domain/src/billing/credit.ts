import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { Money } from '../kernel/money.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface CreditedInvoice {
  baseAmount: string;
  advanceRecovery: string;
  taxTotal: string;
  taxOnAdvanceAtReceipt: boolean;
  /** The tax groups of the stored snapshot: the rates of the original invoice (BR-9). */
  taxGroups: readonly { base: string; ratePercent: string }[];
}

export interface PriorCredits {
  base: string;
  advanceRestored: string;
  tax: string;
}

export interface CreditFigures {
  baseAmount: string;
  advanceRestored: string;
  taxableBase: string;
  taxTotal: string;
  grossTotal: string;
  /** True when this credit returns everything that is still creditable on the invoice. */
  complete: boolean;
}

/**
 * BR-9: a credit note against an issued invoice. The credited base cannot exceed the invoice base
 * less earlier credit notes. Tax is reversed with the rates stored on the invoice, spread over its
 * tax groups by their share of the taxable base; the final credit takes exactly the tax that is
 * left, so the credit notes of an invoice add up to the invoice and never above it. The advance
 * recovery of the credited part goes back to the advance.
 */
export function computeCredit(
  invoice: CreditedInvoice,
  prior: PriorCredits,
  creditBase: string,
): CreditFigures {
  const base = Money.of(creditBase);
  if (!base.value.gt(0)) {
    throw new ValidationError('credit_amount_invalid', 'The credited amount must be above zero');
  }
  const invoiceBase = Money.of(invoice.baseAmount);
  const remainingBase = invoiceBase.sub(Money.of(prior.base));
  if (base.compare(remainingBase) > 0) {
    throw new RuleViolationError(
      'credit_exceeds_invoice',
      `A credit of ${base.toString()} exceeds the ${remainingBase.toString()} still creditable on the invoice`,
    );
  }
  const complete = base.equals(remainingBase);
  const recovery = Money.of(invoice.advanceRecovery);
  const restoreLeft = recovery.sub(Money.of(prior.advanceRestored));
  const restored = complete
    ? restoreLeft
    : Money.of(
        Decimal.min(
          Money.of(recovery.value.times(base.value).div(invoiceBase.value)).value,
          restoreLeft.value,
        ),
      );
  const taxable = invoice.taxOnAdvanceAtReceipt ? base : base.sub(restored);

  const taxLeft = Money.of(invoice.taxTotal).sub(Money.of(prior.tax));
  const groupBase = invoice.taxGroups.reduce((sum, group) => sum.plus(group.base), new Dec(0));
  let tax: Money;
  if (complete) {
    tax = taxLeft;
  } else if (groupBase.isZero()) {
    tax = Money.zero();
  } else {
    const exact = invoice.taxGroups.reduce(
      (sum, group) =>
        sum.plus(taxable.value.times(group.base).div(groupBase).times(group.ratePercent).div(100)),
      new Dec(0),
    );
    tax = Money.of(Decimal.min(Money.of(exact).value, taxLeft.value));
  }
  const gross = taxable.add(tax);
  return {
    baseAmount: base.toString(),
    advanceRestored: restored.toString(),
    taxableBase: taxable.toString(),
    taxTotal: tax.toString(),
    grossTotal: (invoice.taxOnAdvanceAtReceipt ? gross.sub(restored) : gross).toString(),
    complete,
  };
}
