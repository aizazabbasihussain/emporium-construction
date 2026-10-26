import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { hasScope } from '@emporium/domain/identity';
import type { Actor } from '../types.js';

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

/** A reference supplied by the caller must exist. */
export function assertKnown(exists: boolean, code: string, message: string): void {
  if (!exists) throw new ValidationError(code, message);
}

/** Spec section 6 and identity BR-4: a supervisor reaches only the projects assigned to them. */
export function canReachProject(actor: Actor, projectId: string): boolean {
  return hasScope(actor, 'project', projectId);
}

/** For reads and edits of one project: outside the scope is reported as missing (T-3 of identity). */
export function assertProjectReachable(actor: Actor, projectId: string): void {
  if (!canReachProject(actor, projectId)) {
    throw new NotFoundError('project_not_found', 'Not found');
  }
}

/** BR-5: a cost chain with a live row is moved with `transitionCost`, not posted again. */
export function assertChainFree(latestStatus: string | undefined): void {
  if (latestStatus !== undefined && latestStatus !== 'reversed') {
    throw new ConflictError(
      'cost_chain_exists',
      'This source line already has a cost entry; change its status instead',
    );
  }
}

/** BR-6: only the latest row of a chain can move on. */
export function assertLatestInChain(isLatest: boolean): void {
  if (!isLatest) {
    throw new RuleViolationError(
      'cost_entry_superseded',
      'This cost entry has already moved to a later status',
    );
  }
}

/** The project budget can change only while the project is still being run. */
export function assertBudgetEditable(status: string): void {
  if (status === 'closed' || status === 'cancelled') {
    throw new RuleViolationError(
      'project_read_only',
      'The budget of a closed or cancelled project cannot change',
    );
  }
}

/** A variation line, or a budget line from the editor, needs a cost code that is switched on. */
export function assertCostCodeActive(active: boolean): void {
  if (!active) {
    throw new RuleViolationError('cost_code_inactive', 'The cost code is not active');
  }
}
