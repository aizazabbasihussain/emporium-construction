import { ConflictError, NotFoundError, RuleViolationError } from '@emporium/domain';
import {
  canDeactivateCostCode,
  isHardDuplicate,
  type DuplicateMatch,
  type UsageOfCostCode,
} from '@emporium/domain/masterdata';

/** A missing record is reported as not found, whoever asks. */
export function assertFound<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(`${what}_not_found`, 'Not found');
  return row;
}

/** Constitution 5.2: the update matched no row although the record exists, so the version moved on. */
export function assertUpdated<T>(row: T | undefined): T {
  if (row === undefined) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
  return row;
}

/** A delete matched no row although the record exists, so the version moved on. */
export function assertApplied(applied: boolean): void {
  if (!applied) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
}

/** BR-8: a record that documents refer to is set inactive, never deleted. */
export function assertNotReferenced(referenced: boolean, what: string): void {
  if (referenced) {
    throw new ConflictError(
      `${what}_referenced`,
      'Other records use this one; set it inactive instead of deleting it',
    );
  }
}

/** A reference or master record that still has dependants cannot be removed. */
export function assertUnused(used: boolean, code: string, message: string): void {
  if (used) throw new ConflictError(code, message);
}

/**
 * BR-2: repeating an NTN or CNIC is always refused; repeating name plus phone is a warning that the
 * caller confirms explicitly.
 */
export function assertNoDuplicates(matches: readonly DuplicateMatch[], confirmed: boolean): void {
  if (matches.some(isHardDuplicate)) {
    throw new ConflictError('duplicate_party', 'A party with the same NTN or CNIC already exists', {
      matches,
    });
  }
  if (matches.length > 0 && !confirmed) {
    throw new ConflictError(
      'duplicate_warning',
      'A party with the same name and phone already exists',
      { matches },
    );
  }
}

/** BR-6. */
export function assertCostCodeMayDeactivate(usage: UsageOfCostCode): void {
  if (!canDeactivateCostCode(usage)) {
    throw new RuleViolationError(
      'cost_code_in_use',
      'This cost code has posted costs and open budget lines',
    );
  }
}
