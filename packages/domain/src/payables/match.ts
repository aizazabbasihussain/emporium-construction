import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';
import { Money } from '../kernel/money.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const decimal = (value: string, what: string): Decimal => {
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new ValidationError('invalid_decimal', `${what} is not a valid decimal`);
  }
  return new Dec(value.trim());
};

/** Amount of a line: quantity times rate, rounded half-up to 2 decimals (constitution 5.4). */
export function lineAmount(quantity: string, rate: string): string {
  return decimal(quantity, 'Quantity')
    .times(decimal(rate, 'Rate'))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

export interface MatchInput {
  /** The order rate of the purchase order line. */
  poRate: string;
  /** Accepted quantity of the goods received line. */
  receivedQty: string;
  /** Quantity of the same receipt line already billed on other bills. */
  billedBefore: string;
  billedQty: string;
  billedRate: string;
  /** H-23: percent of the open quantity / of the order rate that still counts as matching. */
  qtyTolerancePercent: string;
  rateTolerancePercent: string;
}

export interface MatchResult {
  poRate: string;
  grnQty: string;
  billedQty: string;
  billedRate: string;
  /** Billed quantity above what was received and not yet billed (never negative). */
  qtyVariance: string;
  /** Billed rate less the order rate (signed). */
  rateVariance: string;
  withinTolerance: boolean;
}

/** Quantity still open to bill on a receipt line: received less billed before, never below zero. */
export function openQuantity(receivedQty: string, billedBefore: string): string {
  return Dec.max(
    decimal(receivedQty, 'Quantity').minus(decimal(billedBefore, 'Quantity')),
    0,
  ).toFixed(4);
}

/**
 * BR-1: the three-way match of one bill line against its order line and receipt line. Variances
 * beyond the tolerances (H-23, default zero) need an override with a reason before the bill is
 * `matched`.
 */
export function matchLine(input: MatchInput): MatchResult {
  const open = new Dec(openQuantity(input.receivedQty, input.billedBefore));
  const billedQty = decimal(input.billedQty, 'Quantity');
  const poRate = decimal(input.poRate, 'Rate');
  const billedRate = decimal(input.billedRate, 'Rate');
  const qtyVariance = Dec.max(billedQty.minus(open), 0);
  const rateVariance = billedRate.minus(poRate);
  const qtyAllowed = open.times(decimal(input.qtyTolerancePercent, 'Percent')).div(100);
  const rateAllowed = poRate.times(decimal(input.rateTolerancePercent, 'Percent')).div(100);
  return {
    poRate: poRate.toFixed(4),
    grnQty: decimal(input.receivedQty, 'Quantity').toFixed(4),
    billedQty: billedQty.toFixed(4),
    billedRate: billedRate.toFixed(4),
    qtyVariance: qtyVariance.toFixed(4),
    rateVariance: rateVariance.toFixed(4),
    withinTolerance: qtyVariance.lte(qtyAllowed) && rateVariance.abs().lte(rateAllowed),
  };
}

/** The part of a billed quantity that the receipt covers: the rest is the quantity variance. */
export function coveredQuantity(billedQty: string, qtyVariance: string): string {
  return decimal(billedQty, 'Quantity').minus(decimal(qtyVariance, 'Quantity')).toFixed(4);
}

/**
 * BR-5: what a billed line costs beyond the receipt cost it replaces: the billed amount less the
 * covered quantity at the order rate. Positive when the bill is dearer, negative when cheaper.
 */
export function lineVariance(input: {
  billedAmount: string;
  coveredQty: string;
  poRate: string;
}): string {
  const receiptCost = lineAmount(input.coveredQty, input.poRate);
  return Money.of(input.billedAmount).sub(Money.of(receiptCost)).toString();
}

/**
 * BR-2: a bill is warned about when it is worth more than what the vendor can be owed on orders:
 * the receipts it covers plus the value still open on the vendor's orders.
 */
export function exceedsCommitments(input: {
  billBase: string;
  coveredValue: string;
  openOrderValue: string;
}): boolean {
  return (
    Money.of(input.billBase).compare(
      Money.of(input.coveredValue).add(Money.of(input.openOrderValue)),
    ) > 0
  );
}

/** BR-5, H-22: direct-to-site or already issued goods charge the project; goods in stock charge overhead. */
export function varianceTreatment(input: {
  destination: 'project' | 'store';
  issued: boolean;
}): 'project_cost' | 'overhead_cost' {
  return input.destination === 'project' || input.issued ? 'project_cost' : 'overhead_cost';
}
