import { RuleViolationError, ValidationError } from '../errors.js';
import {
  D,
  fmtMoney,
  fmtQty,
  money,
  nonNegative,
  positiveQuantity,
  ZERO,
  type Dec,
} from '../valuation/amounts.js';

/** Movement types that add to a balance; every other type takes away. */
const INBOUND = new Set([
  'receipt',
  'transfer_in',
  'adjustment_in',
  'return_in',
  'salvage_in',
  'client_receipt',
]);

/** The sign a movement type gives its quantity in the ledger. */
export const directionOf = (type: string): 1 | -1 => (INBOUND.has(type) ? 1 : -1);

/** The ledger stores signed quantities (spec P1-12 section 3). */
export const signedQuantity = (type: string, quantity: string): string => {
  const value = positiveQuantity(quantity);
  return fmtQty(directionOf(type) === 1 ? value : value.negated());
};

/**
 * BR-1: a movement that would make a balance negative is refused with the shortfall. Taking exactly
 * the balance is allowed.
 */
export function assertSufficient(balance: string, wanted: string): void {
  const available = new D(balance);
  const want = positiveQuantity(wanted);
  if (want.greaterThan(available)) {
    const shortfall = fmtQty(want.minus(available));
    throw new RuleViolationError(
      'insufficient_stock',
      `Short by ${shortfall}: ${fmtQty(available)} on hand, ${fmtQty(want)} wanted`,
      { shortfall, available: fmtQty(available) },
    );
  }
}

/** BR-1: only `false` is accepted for the setting `allow_negative_stock` in this version. */
export function assertNegativeStockOff(allowNegative: boolean): void {
  if (allowNegative) {
    throw new RuleViolationError(
      'negative_stock_unsupported',
      'Negative stock is not supported in this version; set allow_negative_stock to false',
    );
  }
}

/** BR-3: the issue is valued by the engine; the single cost entry equals the sum of its parts. */
export function sumParts(parts: readonly { quantity: string; value: string }[]): {
  quantity: string;
  value: string;
} {
  const total = parts.reduce(
    (sum, part) => ({
      quantity: sum.quantity.plus(part.quantity),
      value: sum.value.plus(part.value),
    }),
    { quantity: ZERO, value: ZERO },
  );
  return { quantity: fmtQty(total.quantity), value: fmtMoney(money(total.value)) };
}

/**
 * BR-6, T-6: what is still returnable of an issue is its quantity less what came back before. The
 * request must be positive and within that remainder.
 */
export function assertReturnable(issued: string, returned: string, wanted: string): string {
  const want = positiveQuantity(wanted);
  const remaining = new D(issued).minus(returned);
  if (want.greaterThan(remaining)) {
    throw new RuleViolationError(
      'return_exceeds_issue',
      `Only ${fmtQty(remaining)} of this issue can still be returned`,
      { remaining: fmtQty(remaining) },
    );
  }
  return fmtQty(remaining.minus(want));
}

/**
 * BR-6: the project cost still standing after returns is the issue value less the value valuation
 * gave back, so the restated entry and the returns always add up to the original issue.
 */
export function remainingIssueCost(issuedValue: string, returnedValue: string): string {
  return fmtMoney(money(new D(issuedValue).minus(returnedValue)));
}

/**
 * BR-7, H-21: the value of salvaged material. With the mode `zero` it is nothing; with `estimated`
 * the caller must name a unit value.
 */
export function salvageValue(
  mode: string,
  quantity: string,
  unitValue: string | null | undefined,
): { unitValue: string; value: string } {
  if (mode === 'zero') return { unitValue: '0.0000', value: '0.00' };
  if (mode !== 'estimated') {
    throw new ValidationError('invalid_salvage_mode', `Unknown salvage value mode: ${mode}`);
  }
  if (unitValue === null || unitValue === undefined || unitValue.trim() === '') {
    throw new ValidationError(
      'unit_value_required',
      'A unit value is required for salvaged material',
    );
  }
  const rate = nonNegative(unitValue, 4, 'Unit value');
  return {
    unitValue: rate.toFixed(4),
    value: fmtMoney(money(rate.times(positiveQuantity(quantity)))),
  };
}

/**
 * BR-10: one alert per crossing. Returns whether an alert is due and the new alerted flag: it is
 * raised when the balance is below the level and not yet alerted, and cleared when the balance is
 * back at or above the level.
 */
export function reorderState(
  balance: string,
  level: string | null,
  alerted: boolean,
): { alert: boolean; alerted: boolean } {
  if (level === null) return { alert: false, alerted: false };
  const below = new D(balance).lessThan(level);
  return { alert: below && !alerted, alerted: below };
}

/** BR-12: a balance must equal the signed sum of the ledger for its key. */
export function balanceDifference(balance: string, ledgerSum: string): string | null {
  const diff = new D(balance).minus(ledgerSum);
  return diff.isZero() ? null : fmtQty(diff);
}

/** BR-8: the quantity a count changes a balance by; zero means the count agrees with the books. */
export function countVariance(systemQty: string, countedQty: string): Dec {
  return nonNegative(countedQty, 4, 'Counted quantity').minus(systemQty);
}
