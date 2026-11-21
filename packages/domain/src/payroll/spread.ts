import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface Share {
  key: string;
  /** Any non-negative decimal; only the proportions matter. */
  weight: string;
}

export interface Spread {
  key: string;
  /** Signed money with two decimals. */
  amount: string;
}

const SUM_TOLERANCE_ERROR = 'spread_amount_invalid';

/** Adds money strings exactly, to two decimals. */
export function sumMoney(values: readonly string[]): string {
  return values.reduce((acc, value) => acc.plus(value), new Dec(0)).toFixed(2);
}

/** Whether an amount is above zero (a line with nothing to pay needs no payment). */
export function isPositiveMoney(value: string): boolean {
  return new Dec(value).gt(0);
}

/** `a - b` as money with two decimals (the gross pay less the allocated attendance cost). */
export function moneyDifference(a: string, b: string): string {
  const result = new Dec(a).minus(b);
  return result.isZero() ? '0.00' : result.toFixed(2);
}

/**
 * BR-2: spreads a difference (positive or negative, in whole paisas) over the shares pro rata with
 * the largest-remainder method, so the parts add up to the difference exactly. The paisas left
 * after rounding down go one each to the largest fractional remainders (ties to the first share).
 */
export function spreadDifference(difference: string, shares: readonly Share[]): Spread[] {
  const cents = new Dec(difference).times(100);
  if (!cents.isInteger()) {
    throw new ValidationError(SUM_TOLERANCE_ERROR, 'The difference has more than two decimals');
  }
  const total = shares.reduce((acc, share) => acc.plus(share.weight), new Dec(0));
  if (shares.some((share) => new Dec(share.weight).isNegative()) || !total.gt(0)) {
    throw new ValidationError('spread_no_weight', 'There is nothing to spread the difference over');
  }
  const magnitude = cents.abs();
  const exact = shares.map((share) => magnitude.times(share.weight).div(total));
  const floors = exact.map((value) => value.floor());
  const leftover = magnitude.minus(floors.reduce((acc, value) => acc.plus(value), new Dec(0)));
  const order = exact
    .map((value, index) => ({ index, fraction: value.minus(floors[index] as Decimal) }))
    .sort((a, b) => b.fraction.comparedTo(a.fraction) || a.index - b.index);
  const extra = new Set(order.slice(0, leftover.toNumber()).map((entry) => entry.index));
  return shares.map((share, index) => {
    const parts = (floors[index] as Decimal).plus(extra.has(index) ? 1 : 0);
    const signed = cents.isNegative() ? parts.neg() : parts;
    return { key: share.key, amount: signed.isZero() ? '0.00' : signed.div(100).toFixed(2) };
  });
}
