import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import { parseQuantity } from './rules.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface ReceiptLineInput {
  poLineId: string;
  acceptedQty: string;
  rejectedQty?: string | undefined;
  note?: string | undefined;
}

export interface ReceiptLine {
  poLineId: string;
  acceptedQty: string;
  rejectedQty: string;
  note: string;
}

/** A receipt line has non-negative quantities; the receipt must accept or reject something. */
export function normalizeReceiptLines(inputs: readonly ReceiptLineInput[]): ReceiptLine[] {
  const lines = inputs.map((input) => ({
    poLineId: input.poLineId,
    acceptedQty: parseQuantity(input.acceptedQty, 'accepted_qty').toFixed(4),
    rejectedQty: parseQuantity(input.rejectedQty ?? '0', 'rejected_qty').toFixed(4),
    note: (input.note ?? '').trim(),
  }));
  if (!lines.some((line) => new Dec(line.acceptedQty).plus(line.rejectedQty).greaterThan(0))) {
    throw new ValidationError('lines_required', 'Receive or reject something on at least one line');
  }
  if (new Set(lines.map((line) => line.poLineId)).size !== lines.length) {
    throw new ValidationError('duplicate_line', 'A line can be received only once per receipt');
  }
  return lines;
}

/**
 * BR-6: the most that can be accepted now is the ordered quantity less what was received, plus the
 * over-receipt tolerance (a percent of the ordered quantity; H-23, default 0).
 */
export function maxAcceptable(ordered: string, received: string, tolerancePercent: string): string {
  const tolerance = new Dec(ordered).times(new Dec(tolerancePercent)).div(100);
  const room = new Dec(ordered).minus(received).plus(tolerance);
  return Dec.max(room, 0).toFixed(4);
}

export function assertWithinTolerance(
  accepted: string,
  ordered: string,
  received: string,
  tolerancePercent: string,
): void {
  if (new Dec(accepted).greaterThan(maxAcceptable(ordered, received, tolerancePercent))) {
    throw new RuleViolationError(
      'over_receipt',
      'The accepted quantity is more than the order allows',
    );
  }
}

/** BR-7: the cost of an accepted quantity at the order rate, rounded half-up to 2 decimals. */
export function receiptCost(acceptedQty: string, rate: string): string {
  return new Dec(acceptedQty).times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** What stays committed on an order line once the receipt costs are taken out (never negative). */
export function remainingCommitment(lineTotal: string, receivedCost: string): string {
  return Dec.max(new Dec(lineTotal).minus(receivedCost), 0).toFixed(2);
}

/** BR-11 */
export function assertPhotoAttached(required: boolean, photoCount: number): void {
  if (required && photoCount === 0) {
    throw new RuleViolationError(
      'grn_photo_required',
      'Attach a photo of the delivery challan first',
    );
  }
}

/** Exact quantity arithmetic for the received quantity of an order line (4 decimals). */
export const addQuantity = (a: string, b: string): string => new Dec(a).plus(b).toFixed(4);
export const subQuantity = (a: string, b: string): string => new Dec(a).minus(b).toFixed(4);
