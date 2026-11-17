import { RuleViolationError, ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/business-date.js';

// Effective-dated ranges shared by every tax rule table (spec P2-01 BR-2 and BR-5). Dates are
// yyyy-mm-dd strings, which compare correctly as text.

export interface DateRange {
  effectiveFrom: string;
  /** Inclusive; null means open-ended. */
  effectiveTo: string | null;
}

const FOREVER = '9999-12-31';

export const inRange = (range: DateRange, date: string): boolean =>
  range.effectiveFrom <= date && (range.effectiveTo === null || date <= range.effectiveTo);

export const rangesOverlap = (a: DateRange, b: DateRange): boolean =>
  a.effectiveFrom <= (b.effectiveTo ?? FOREVER) && b.effectiveFrom <= (a.effectiveTo ?? FOREVER);

export function assertValidRange(range: DateRange): void {
  BusinessDate.parse(range.effectiveFrom);
  if (range.effectiveTo !== null) {
    BusinessDate.parse(range.effectiveTo);
    if (range.effectiveTo < range.effectiveFrom) {
      throw new ValidationError('tax_range_invalid', 'The rule cannot end before it starts');
    }
  }
}

export interface Closure {
  id: string;
  effectiveTo: string;
}

/**
 * BR-2 and BR-5: a new rule may not overlap an existing one of the same key. The one exception is
 * a successor: a new open-ended rule that starts after an open-ended rule closes that rule the day
 * before it starts. Returns the closures to apply when the new rule becomes active.
 */
export function checkSuccession(
  next: DateRange,
  existing: readonly (DateRange & { id: string })[],
): { closures: Closure[]; conflict: string | null } {
  const closures: Closure[] = [];
  for (const other of existing.filter((candidate) => rangesOverlap(next, candidate))) {
    const successor =
      next.effectiveTo === null &&
      other.effectiveTo === null &&
      other.effectiveFrom < next.effectiveFrom;
    if (!successor) {
      return {
        closures: [],
        conflict: `The dates overlap an existing rule (${other.effectiveFrom} to ${other.effectiveTo ?? 'open'})`,
      };
    }
    closures.push({
      id: other.id,
      effectiveTo: BusinessDate.parse(next.effectiveFrom).addDays(-1).toString(),
    });
  }
  return { closures, conflict: null };
}

/** The same check, raising the conflict as an error (used when a rule is requested). */
export function planSuccession(
  next: DateRange,
  existing: readonly (DateRange & { id: string })[],
): Closure[] {
  const { closures, conflict } = checkSuccession(next, existing);
  if (conflict !== null) throw new RuleViolationError('tax_rule_overlap', conflict);
  return closures;
}
