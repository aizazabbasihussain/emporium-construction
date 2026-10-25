import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';

// Exact arithmetic for stock valuation (spec P1-13). Quantities have 4 places, money 2, unit costs 4.

export const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export const ZERO = new D(0);

export const money = (value: Dec): Dec => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const rate = (value: Dec): Dec => value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

export const fmtMoney = (value: Dec): string => value.toFixed(2);
export const fmtQty = (value: Dec): string => value.toFixed(4);
export const fmtRate = (value: Dec): string => value.toFixed(4);

/** Parse a decimal given as text with at most `places` decimals; floats never enter. */
export function parseDecimal(text: string, places: number, what: string): Dec {
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new ValidationError('invalid_decimal', `${what} is not a valid decimal`);
  }
  const value = new D(text);
  if (value.decimalPlaces() > places) {
    throw new ValidationError(
      'decimal_precision',
      `${what} allows at most ${places} decimal places`,
    );
  }
  return value;
}

export function positiveQuantity(text: string): Dec {
  const value = parseDecimal(text, 4, 'Quantity');
  if (!value.greaterThan(0)) {
    throw new ValidationError('quantity_not_positive', 'Quantity must be greater than zero');
  }
  return value;
}

export function nonNegative(text: string, places: number, what: string): Dec {
  const value = parseDecimal(text, places, what);
  if (value.isNegative()) {
    throw new ValidationError('amount_negative', `${what} must not be negative`);
  }
  return value;
}

/** BR-7: valuation never invents value, so an issue larger than the known quantity is refused. */
export function assertEnough(available: Dec, wanted: Dec): void {
  if (wanted.greaterThan(available)) {
    throw new RuleViolationError(
      'insufficient_valuation_quantity',
      `Cannot issue ${fmtQty(wanted)}: only ${fmtQty(available)} is known to valuation`,
    );
  }
}

/**
 * BR-6: for every key the value after equals the value before plus receipts minus issues, to the
 * paisa. A violation is a defect, never a user error.
 */
export function assertConserved(input: {
  before: Dec;
  receipts: Dec;
  issues: Dec;
  after: Dec;
}): void {
  const expected = input.before.plus(input.receipts).minus(input.issues);
  if (!expected.equals(input.after)) {
    throw new RuleViolationError(
      'conservation_violated',
      `Stock value after (${fmtMoney(input.after)}) differs from ${fmtMoney(expected)}`,
    );
  }
}
