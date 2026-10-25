import Decimal from 'decimal.js';
import { ValidationError } from '../errors.js';
import type { LineKind, SuppliedBy } from './costing.js';
import { evaluateNode, parseFormula } from './formula.js';
import type { TemplateParameter } from './rules.js';

export interface TemplateLineSource {
  lineNo: number;
  description: string;
  lineKind: LineKind;
  itemId: string | null;
  costCodeId: string;
  unitCode: string;
  qtyFormula: string;
  defaultRate: string | null;
  suppliedBy: SuppliedBy;
}

export interface InstantiatedLine extends Omit<TemplateLineSource, 'qtyFormula' | 'defaultRate'> {
  quantity: string;
}

/** Parameter values are non-negative decimals, one per template parameter. */
export function checkParameterValues(
  parameters: readonly TemplateParameter[],
  values: Readonly<Record<string, string>>,
): Map<string, string> {
  const checked = new Map<string, string>();
  for (const { key } of parameters) {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value === undefined) {
      throw new ValidationError('parameter_missing', `Parameter ${key} needs a value`);
    }
    if (!/^\d+(\.\d+)?$/.test(value)) {
      throw new ValidationError('parameter_invalid', `Parameter ${key} must be a number`);
    }
    checked.set(key, value);
  }
  return checked;
}

/** One formula evaluated to a quantity of at most 4 decimals, half-up (constitution 5.5). */
export function evaluateQuantity(formula: string, values: ReadonlyMap<string, string>): string {
  const result = evaluateNode(parseFormula(formula), values);
  if (result.isNegative() && !result.isZero()) {
    throw new ValidationError('quantity_negative', 'A formula produced a negative quantity');
  }
  return result.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

/** BR-2: the template lines with each quantity formula evaluated for the given parameter values. */
export function instantiateLines(
  lines: readonly TemplateLineSource[],
  parameters: readonly TemplateParameter[],
  values: Readonly<Record<string, string>>,
): InstantiatedLine[] {
  const checked = checkParameterValues(parameters, values);
  return lines.map(({ qtyFormula, defaultRate: _rate, ...line }) => ({
    ...line,
    quantity: evaluateQuantity(qtyFormula, checked),
  }));
}

export interface PriceCandidate {
  rate: string;
  validFrom: string;
  validTo: string | null;
}

/**
 * BR-3: the rate of the latest valid vendor price (the most recent `validFrom` in force on the
 * date), else the template default, else zero.
 */
export function defaultRate(
  prices: readonly PriceCandidate[],
  onDate: string,
  templateDefault: string | null,
): string {
  const inForce = prices.filter(
    (price) => price.validFrom <= onDate && (price.validTo === null || price.validTo >= onDate),
  );
  const latest = inForce.reduce<PriceCandidate | undefined>(
    (best, price) => (best === undefined || price.validFrom > best.validFrom ? price : best),
    undefined,
  );
  return latest?.rate ?? templateDefault ?? '0.0000';
}

/**
 * A non-negative decimal with at most `places` decimals, returned with exactly `places` decimals.
 * `max` is an optional inclusive upper bound.
 */
export function normalizeDecimal(
  text: string,
  field: string,
  places: number,
  max?: string,
): string {
  const match = /^(\d{1,14})(?:\.(\d+))?$/.exec(text.trim());
  if (match === null || (match[2] ?? '').length > places) {
    throw new ValidationError(`invalid_${field}`, `${field} is not a valid number`);
  }
  const value = new Decimal(text.trim());
  if (max !== undefined && value.greaterThan(max)) {
    throw new ValidationError(`invalid_${field}`, `${field} must not exceed ${max}`);
  }
  return value.toFixed(places);
}
