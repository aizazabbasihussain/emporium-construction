import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { hasScope } from '@emporium/domain/identity';
import { variationsPermissions, type FileOperation } from '@emporium/shared';
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

export function assertApplied(applied: boolean): void {
  if (!applied) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
}

/** A reference supplied by the caller must exist. */
export function assertKnown(exists: boolean, code: string, message: string): void {
  if (!exists) throw new ValidationError(code, message);
}

/** Spec section 6 and identity BR-4: a supervisor reaches only the projects assigned to them. */
export function assertProjectReachable(
  actor: Pick<Actor, 'roles' | 'scopes'>,
  projectId: string,
): void {
  if (!hasScope(actor, 'project', projectId)) {
    throw new NotFoundError('project_not_found', 'Not found');
  }
}

/** BR-1: a variation belongs to a project that is active. */
export function assertProjectActive(status: string): void {
  if (status !== 'active') {
    throw new RuleViolationError(
      'project_not_active',
      'Variations can be made only on an active project',
    );
  }
}

/** A variation line needs a cost code that is switched on. */
export function assertCostCodeActive(active: boolean): void {
  if (!active) {
    throw new RuleViolationError('cost_code_inactive', 'The cost code is not active');
  }
}

/**
 * BR-4: the client's letter or signed form. Anyone who may read variations sees it; adding or
 * removing it needs the permission to record the client's decision.
 */
export function canAccessClientDocument(request: {
  permissions: ReadonlySet<string>;
  operation: FileOperation;
  variationExists: boolean;
}): boolean {
  if (!request.variationExists) return false;
  return request.operation === 'read'
    ? request.permissions.has(variationsPermissions.read)
    : request.permissions.has(variationsPermissions.clientApprove);
}
