import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const lineKinds = [
  'material',
  'labour',
  'subcontract',
  'equipment',
  'disposal',
  'salvage_credit',
] as const;
export type LineKind = (typeof lineKinds)[number];

export const suppliers = ['company', 'client'] as const;
export type SuppliedBy = (typeof suppliers)[number];

export interface CostLine {
  lineKind: LineKind;
  quantity: string;
  rate: string;
  suppliedBy: SuppliedBy;
}

export interface EstimateTerms {
  overheadPercent: string;
  contingencyPercent: string;
  targetMarginPercent: string;
  proposedPrice: string | null;
}

export interface EstimateTotals {
  companyCost: string;
  clientSuppliedValue: string;
  overheadAmount: string;
  contingencyAmount: string;
  totalCost: string;
  proposedPrice: string | null;
  expectedMargin: string | null;
  /** Null when there is no price or the price is zero (BR-7). */
  marginPercent: string | null;
  targetMarginPercent: string;
  /** Null when the margin percent is null. */
  meetsTarget: boolean | null;
}

const money = (value: Decimal): Decimal => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

function decimalOf(text: string, what: string): Decimal {
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new ValidationError('invalid_decimal', `${what} is not a valid decimal`);
  }
  return new Dec(text);
}

/** BR-4: quantity times rate, rounded half-up to 2 decimals. */
export function lineTotal(line: Pick<CostLine, 'quantity' | 'rate'>): string {
  return money(decimalOf(line.quantity, 'quantity').times(decimalOf(line.rate, 'rate'))).toFixed(2);
}

/** BR-3: a line the company buys with a zero rate has no price yet. */
export function isRateMissing(line: Pick<CostLine, 'rate' | 'suppliedBy'>): boolean {
  return line.suppliedBy === 'company' && decimalOf(line.rate, 'rate').isZero();
}

/** BR-5, BR-6, BR-7. Lines of the client never enter company cost. */
export function estimateTotals(lines: readonly CostLine[], terms: EstimateTerms): EstimateTotals {
  let company = new Dec(0);
  let client = new Dec(0);
  for (const line of lines) {
    const total = new Dec(lineTotal(line));
    if (line.suppliedBy === 'client') client = client.plus(total);
    else company = line.lineKind === 'salvage_credit' ? company.minus(total) : company.plus(total);
  }
  const overhead = money(company.times(decimalOf(terms.overheadPercent, 'overhead')).div(100));
  const contingency = money(
    company.times(decimalOf(terms.contingencyPercent, 'contingency')).div(100),
  );
  const totalCost = company.plus(overhead).plus(contingency);
  const price = terms.proposedPrice === null ? null : decimalOf(terms.proposedPrice, 'price');
  const margin = price === null ? null : price.minus(totalCost);
  const percent =
    margin === null || price === null || price.isZero()
      ? null
      : margin.div(price).times(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const target = decimalOf(terms.targetMarginPercent, 'target margin');
  return {
    companyCost: company.toFixed(2),
    clientSuppliedValue: client.toFixed(2),
    overheadAmount: overhead.toFixed(2),
    contingencyAmount: contingency.toFixed(2),
    totalCost: totalCost.toFixed(2),
    proposedPrice: price === null ? null : money(price).toFixed(2),
    expectedMargin: margin === null ? null : money(margin).toFixed(2),
    marginPercent: percent === null ? null : percent.toFixed(4),
    targetMarginPercent: target.toFixed(4),
    meetsTarget: percent === null ? null : percent.greaterThanOrEqualTo(target),
  };
}

/** The amount a line adds to company cost: negative for a salvage credit (BR-5). */
export function signedLineTotal(line: Pick<CostLine, 'lineKind' | 'quantity' | 'rate'>): string {
  const total = lineTotal(line);
  return line.lineKind === 'salvage_credit' && total !== '0.00' ? `-${total}` : total;
}
