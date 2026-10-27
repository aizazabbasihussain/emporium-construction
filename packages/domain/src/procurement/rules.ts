import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const decimal = (text: string, field: string, places: number): Decimal => {
  const pattern = new RegExp(`^\\d{1,14}(\\.\\d{1,${places}})?$`);
  if (!pattern.test(text.trim())) {
    throw new ValidationError(
      `${field}_invalid`,
      `${field} must be a number with at most ${places} decimals`,
    );
  }
  return new Dec(text.trim());
};

export const parseQuantity = (text: string, field = 'quantity'): Decimal => decimal(text, field, 4);

/** BR-3: line total = quantity x rate, rounded half-up to 2 decimals. */
export function lineTotal(quantity: string, rate: string): string {
  return new Dec(quantity)
    .times(new Dec(rate))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

/** Sum of amounts that are already rounded to 2 decimals. */
export function sumMoney(amounts: readonly string[]): string {
  return amounts.reduce((sum, amount) => sum.plus(new Dec(amount)), new Dec(0)).toFixed(2);
}

function positiveQuantity(text: string): string {
  const value = parseQuantity(text);
  if (value.lessThanOrEqualTo(0)) {
    throw new ValidationError('quantity_invalid', 'quantity must be more than zero');
  }
  return value.toFixed(4);
}

export interface RequisitionLineInput {
  itemId: string;
  description?: string | undefined;
  quantity: string;
  unitCode: string;
  costCodeId: string;
  estimatedRate?: string | null | undefined;
}

export interface RequisitionLine {
  lineNo: number;
  itemId: string;
  description: string;
  quantity: string;
  unitCode: string;
  costCodeId: string;
  estimatedRate: string | null;
}

export function normalizeRequisitionLines(
  inputs: readonly RequisitionLineInput[],
): RequisitionLine[] {
  if (inputs.length === 0) {
    throw new ValidationError('lines_required', 'Add at least one line');
  }
  return inputs.map((input, index) => ({
    lineNo: index + 1,
    itemId: input.itemId,
    description: (input.description ?? '').trim(),
    quantity: positiveQuantity(input.quantity),
    unitCode: input.unitCode.trim(),
    costCodeId: input.costCodeId,
    estimatedRate:
      input.estimatedRate === undefined || input.estimatedRate === null
        ? null
        : decimal(input.estimatedRate, 'estimated_rate', 4).toFixed(4),
  }));
}

export type Destination = { type: 'project'; id: string } | { type: 'store'; id: string };

/** BR-1: a requisition names a project (direct to site) or a store (replenishment), not both. */
export function destinationOf(ids: {
  projectId?: string | null | undefined;
  storeId?: string | null | undefined;
}): Destination {
  const projectId = ids.projectId ?? null;
  const storeId = ids.storeId ?? null;
  if ((projectId === null) === (storeId === null)) {
    throw new ValidationError(
      'destination_required',
      'Name either a project or a store, not both and not neither',
    );
  }
  return projectId === null
    ? { type: 'store', id: storeId as string }
    : { type: 'project', id: projectId };
}

export interface PoLineInput {
  itemId: string;
  description?: string | undefined;
  quantity: string;
  unitCode: string;
  rate: string;
  costCodeId: string;
  requisitionLineId?: string | null | undefined;
}

export interface PoLine {
  lineNo: number;
  itemId: string;
  description: string;
  quantity: string;
  unitCode: string;
  rate: string;
  lineTotal: string;
  costCodeId: string;
  requisitionLineId: string | null;
}

/** BR-3: each line total is rounded; the order total is the sum of the rounded line totals. */
export function normalizePoLines(inputs: readonly PoLineInput[]): {
  lines: PoLine[];
  total: string;
} {
  if (inputs.length === 0) {
    throw new ValidationError('lines_required', 'Add at least one line');
  }
  const lines = inputs.map((input, index) => {
    const quantity = positiveQuantity(input.quantity);
    const rate = decimal(input.rate, 'rate', 4).toFixed(4);
    return {
      lineNo: index + 1,
      itemId: input.itemId,
      description: (input.description ?? '').trim(),
      quantity,
      unitCode: input.unitCode.trim(),
      rate,
      lineTotal: lineTotal(quantity, rate),
      costCodeId: input.costCodeId,
      requisitionLineId: input.requisitionLineId ?? null,
    };
  });
  return { lines, total: sumMoney(lines.map((line) => line.lineTotal)) };
}

/** BR-5: an amended line never orders less than was already received on it. */
export function assertNotBelowReceived(newQuantity: string, receivedQty: string): void {
  if (new Dec(newQuantity).lessThan(new Dec(receivedQty))) {
    throw new RuleViolationError(
      'below_received',
      'A line cannot be ordered for less than was already received',
    );
  }
}

/** The order status that follows from the received quantities of an approved order. */
export function receiptStatus(
  lines: readonly { quantity: string; receivedQty: string }[],
): 'approved' | 'partly_received' | 'received' {
  if (!lines.some((line) => new Dec(line.receivedQty).greaterThan(0))) return 'approved';
  const all = lines.every((line) =>
    new Dec(line.receivedQty).greaterThanOrEqualTo(new Dec(line.quantity)),
  );
  return all ? 'received' : 'partly_received';
}

/** The requisition status that follows from how much of each line is on an active order. */
export function orderedStatus(
  lines: readonly { quantity: string; ordered: string }[],
): 'approved' | 'partly_ordered' | 'ordered' {
  if (!lines.some((line) => new Dec(line.ordered).greaterThan(0))) return 'approved';
  const all = lines.every((line) =>
    new Dec(line.ordered).greaterThanOrEqualTo(new Dec(line.quantity)),
  );
  return all ? 'ordered' : 'partly_ordered';
}

/** Document numbers of this module: `REQ-2026-0001`. */
export const documentNumber = (prefix: string, year: number, seq: number): string =>
  `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
