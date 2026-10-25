import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import type { EstimateStatus } from '@emporium/domain/estimation';

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

export function assertApplied(applied: boolean): void {
  if (!applied) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
}

/** A code or id supplied by the caller must exist in its reference list. */
export function assertKnown(exists: boolean, code: string, message: string): void {
  if (!exists) throw new ValidationError(code, message);
}

export function assertCodeFree(taken: boolean): void {
  if (taken) throw new ConflictError('code_taken', 'This template code is already used');
}

/** A new estimate can be built only from a template that is switched on. */
export function assertTemplateActive(active: boolean): void {
  if (!active) throw new RuleViolationError('template_inactive', 'This template is switched off');
}

/** BR-8: only a locked estimate can be revised, and only one revision may be open at a time. */
export function assertRevisable(status: EstimateStatus, openRevision: boolean): void {
  if (status !== 'locked') {
    throw new RuleViolationError('estimate_not_locked', 'Only a locked estimate can be revised');
  }
  if (openRevision) {
    throw new ConflictError('revision_open', 'This estimate already has a revision in progress');
  }
}

/** The budget (P1-09) is read from a locked estimate only. */
export function assertLockedForBudget(status: EstimateStatus): void {
  if (status !== 'locked') {
    throw new RuleViolationError('estimate_not_locked', 'The estimate is not locked');
  }
}
