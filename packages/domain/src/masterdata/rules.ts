import Decimal from 'decimal.js';
import { RuleViolationError, ValidationError } from '../errors.js';

// Pure master data rules (spec P1-05 section 4). Nothing here touches a database.

const NON_STOCKABLE_KINDS = ['service', 'labour', 'equipment'] as const;
const QUANTITY_PLACES = 4;

/** BR-3: a CNIC is 13 digits; hyphens and spaces in the input are removed. */
export function normalizeCnic(raw: string): string {
  const stripped = raw.replace(/[-\s]/g, '');
  if (!/^\d{13}$/.test(stripped)) {
    throw new ValidationError('invalid_cnic', 'A CNIC must have 13 digits');
  }
  return stripped;
}

/**
 * BR-3: Pakistan numbers in E.164. Accepts `+92`, `0092`, `92` or a leading trunk `0`, with
 * spaces, hyphens, dots and brackets as separators. The national number has 9 or 10 digits.
 */
export function normalizePhone(raw: string): string {
  const compact = raw.replace(/[\s\-.()]/g, '');
  if (!/^\+?\d+$/.test(compact)) {
    throw new ValidationError('invalid_phone', 'A phone number may contain only digits');
  }
  let national: string;
  if (compact.startsWith('+')) {
    if (!compact.startsWith('+92')) {
      throw new ValidationError('invalid_phone', 'Only Pakistan phone numbers (+92) are accepted');
    }
    national = compact.slice(3);
  } else if (compact.startsWith('0092')) {
    national = compact.slice(4);
  } else if (compact.startsWith('92') && compact.length >= 11) {
    national = compact.slice(2);
  } else if (compact.startsWith('0')) {
    national = compact.slice(1);
  } else {
    throw new ValidationError(
      'invalid_phone',
      'Enter a Pakistan phone number such as 0300 1234567',
    );
  }
  if (!/^[1-9]\d{8,9}$/.test(national)) {
    throw new ValidationError('invalid_phone', 'The phone number has the wrong length');
  }
  return `+92${national}`;
}

/** NTN and STRN are compared without spaces or hyphens and in upper case. */
export function normalizeTaxNumber(raw: string): string {
  const cleaned = raw.replace(/[-\s]/g, '').toUpperCase();
  if (!/^[0-9A-Z]{3,20}$/.test(cleaned)) {
    throw new ValidationError('invalid_tax_number', 'The tax number is not valid');
  }
  return cleaned;
}

/** Names are compared ignoring case and repeated spaces (BR-2). */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface PartyIdentity {
  id?: string | undefined;
  name: string;
  phone: string | null;
  ntn: string | null;
  cnic: string | null;
}

export type DuplicateReason = 'name_phone' | 'ntn' | 'cnic';

export interface DuplicateMatch {
  id: string;
  reason: DuplicateReason;
}

/**
 * BR-2: which existing parties the candidate repeats. `phone`, `ntn` and `cnic` must already be
 * normalized. A party never matches itself, and a missing field never matches anything.
 */
export function findDuplicates(
  candidate: PartyIdentity,
  existing: readonly (PartyIdentity & { id: string })[],
): DuplicateMatch[] {
  const name = normalizeName(candidate.name);
  const matches: DuplicateMatch[] = [];
  for (const other of existing) {
    if (other.id === candidate.id) continue;
    if (candidate.cnic !== null && other.cnic === candidate.cnic) {
      matches.push({ id: other.id, reason: 'cnic' });
    } else if (candidate.ntn !== null && other.ntn === candidate.ntn) {
      matches.push({ id: other.id, reason: 'ntn' });
    } else if (
      candidate.phone !== null &&
      other.phone === candidate.phone &&
      normalizeName(other.name) === name
    ) {
      matches.push({ id: other.id, reason: 'name_phone' });
    }
  }
  return matches;
}

/** NTN and CNIC are unique, so repeating them is an error; name plus phone only warns (BR-2). */
export const isHardDuplicate = (match: DuplicateMatch): boolean => match.reason !== 'name_phone';

/** BR-4: only materials and consumables can be held in stock. */
export function assertStockableRule(kind: string, stockable: boolean): void {
  if (stockable && (NON_STOCKABLE_KINDS as readonly string[]).includes(kind)) {
    throw new RuleViolationError('item_not_stockable', `A ${kind} item cannot be stockable`);
  }
}

/** The stockable flag when the user does not choose one. */
export const defaultStockable = (kind: string): boolean =>
  kind === 'material' || kind === 'consumable';

/** Quantities and rates are plain decimals with at most `places` decimals, never negative. */
export function assertDecimal(text: string, places: number, code: string): string {
  const pattern = new RegExp(String.raw`^\d{1,14}(\.\d{1,${places}})?$`);
  if (!pattern.test(text)) {
    throw new ValidationError(code, `Enter a number of at least 0 with up to ${places} decimals`);
  }
  return text;
}

export interface ConversionPair {
  fromUnit: string;
  toUnit: string;
  factor: string;
}

const round = (value: Decimal): string =>
  value.toDecimalPlaces(QUANTITY_PLACES, Decimal.ROUND_HALF_UP).toFixed(QUANTITY_PLACES);

/**
 * BR-5: converts with a direct pair or its inverse; chains are not followed. The same unit just
 * rounds. A missing pair is an error. The result has 4 decimals, rounded half-up.
 */
export function convertQuantity(
  quantity: string,
  fromUnit: string,
  toUnit: string,
  pairs: readonly ConversionPair[],
): string {
  const value = new Decimal(quantity);
  if (fromUnit === toUnit) return round(value);
  const direct = pairs.find((p) => p.fromUnit === fromUnit && p.toUnit === toUnit);
  if (direct !== undefined) return round(value.mul(direct.factor));
  const inverse = pairs.find((p) => p.fromUnit === toUnit && p.toUnit === fromUnit);
  if (inverse !== undefined) return round(value.div(inverse.factor));
  throw new RuleViolationError(
    'conversion_missing',
    `There is no conversion between ${fromUnit} and ${toUnit}`,
  );
}

/** A conversion factor is positive and fits numeric(18,6); a unit cannot convert to itself. */
export function assertConversionPair(pair: ConversionPair): void {
  if (pair.fromUnit === pair.toUnit) {
    throw new ValidationError('conversion_same_unit', 'A unit cannot convert to itself');
  }
  const factor = new Decimal(pair.factor);
  if (!factor.gt(0) || factor.decimalPlaces() > 6 || factor.gte(new Decimal(10).pow(12))) {
    throw new ValidationError(
      'conversion_factor_invalid',
      'The factor must be above zero with at most 6 decimals',
    );
  }
}

/**
 * Would giving `nodeId` the parent `parentId` close a loop? `parents` maps every node to its
 * current parent. Used for cost codes (BR-6) and item categories.
 */
export function wouldCreateCycle(
  nodeId: string,
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): boolean {
  const seen = new Set<string>();
  let cursor = parentId;
  while (cursor !== null) {
    if (cursor === nodeId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return false;
}

export function assertNoCycle(
  nodeId: string,
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): void {
  if (wouldCreateCycle(nodeId, parentId, parents)) {
    throw new RuleViolationError('hierarchy_cycle', 'A record cannot be placed under itself');
  }
}

export interface UsageOfCostCode {
  postedCosts: boolean;
  openBudgetLines: boolean;
}

/** BR-6: a code with posted costs can be deactivated only when no budget line is still open. */
export const canDeactivateCostCode = (usage: UsageOfCostCode): boolean =>
  !(usage.postedCosts && usage.openBudgetLines);

export interface DateRange {
  validFrom: string;
  validTo: string | null;
}

/** Dates are `yyyy-mm-dd`, so string comparison orders them. An open end never ends. */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  const aEndsBeforeB = a.validTo !== null && a.validTo < b.validFrom;
  const bEndsBeforeA = b.validTo !== null && b.validTo < a.validFrom;
  return !aEndsBeforeB && !bEndsBeforeA;
}

export function assertValidRange(range: DateRange): void {
  if (range.validTo !== null && range.validTo < range.validFrom) {
    throw new ValidationError('invalid_date_range', 'The end date is before the start date');
  }
}

/** BR-7: at most one registration of an (authority, type) is in force on a date. */
export function assertNoRegistrationOverlap(
  candidate: DateRange & { id?: string },
  others: readonly (DateRange & { id: string })[],
): void {
  if (others.some((other) => other.id !== candidate.id && rangesOverlap(candidate, other))) {
    throw new RuleViolationError(
      'registration_overlap',
      'Another registration of this type is in force in that period',
    );
  }
}

export const isInForce = (range: DateRange, date: string): boolean =>
  range.validFrom <= date && (range.validTo === null || date <= range.validTo);

/** Normalizes an authority code such as `fbr` to `FBR`. */
export function normalizeAuthority(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(code)) {
    throw new ValidationError(
      'invalid_authority',
      'Use letters, digits and _ (2 to 20 characters)',
    );
  }
  return code;
}

/** Parties get their code from the number series of their first role (BR-1). */
export const seriesForRole = (role: string): string => `party_${role}`;
