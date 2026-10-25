import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';
import type { BusinessDate } from '../kernel/business-date.js';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** BR-2: margin percent = (price - total estimated cost) / price, to four decimals, half-up. */
export function marginPercent(price: string, totalCost: string): string {
  const value = new Dec(price);
  return value.minus(totalCost).div(value).times(100).toDecimalPlaces(4).toFixed(4);
}

export interface MarginPanel {
  totalCost: string;
  marginAmount: string;
  marginPercent: string;
  floorPercent: string;
  belowFloor: boolean;
}

/** BR-2: the margin of a price against the locked estimate's total cost, checked against the floor. */
export function marginPanel(price: string, totalCost: string, floorPercent: string): MarginPanel {
  const margin = marginPercent(price, totalCost);
  return {
    totalCost: new Dec(totalCost).toFixed(2),
    marginAmount: new Dec(price).minus(totalCost).toFixed(2),
    marginPercent: margin,
    floorPercent: new Dec(floorPercent).toFixed(4),
    belowFloor: isBelowFloor(margin, floorPercent),
  };
}

/** BR-2: below the floor means strictly less than it; at the floor is fine. */
export function isBelowFloor(margin: string, floor: string): boolean {
  return new Dec(margin).lessThan(floor);
}

/** BR-7: the first revision shows the base number; later ones add `/<revision>`. */
export function displayNumber(number: string, revision: number): string {
  return revision <= 1 ? number : `${number}/${revision}`;
}

export const MAX_VALIDITY_DAYS = 365;

export function assertValidityDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > MAX_VALIDITY_DAYS) {
    throw new ValidationError(
      'validity_days_invalid',
      `Validity must be between 1 and ${MAX_VALIDITY_DAYS} days`,
    );
  }
}

/** BR-5: the quotation can still be accepted on the expiry date itself. */
export function expiryDate(issuedOn: BusinessDate, validityDays: number): BusinessDate {
  return issuedOn.addDays(validityDays);
}

/** BR-5: expired only after the expiry date has passed (the expiry date is inclusive). */
export function isExpired(expiresOn: BusinessDate, today: BusinessDate): boolean {
  return today.isAfter(expiresOn);
}

/** BR-6: a government quotation needs the client's acceptance document. */
export function assertAcceptanceProof(sector: string, hasAttachment: boolean): void {
  if (sector === 'government' && !hasAttachment) {
    throw new RuleViolationError(
      'acceptance_document_required',
      'Attach the client acceptance document before accepting a government quotation',
    );
  }
}

/** BR-10: a rejection (and the name of who accepted) must be written down. */
export function requireText(value: string | null | undefined, code: string): string {
  const text = value?.trim() ?? '';
  if (text === '') {
    throw new ValidationError(code, 'This field is required');
  }
  return text;
}
