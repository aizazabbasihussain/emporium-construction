import { ConflictError, NotFoundError, ValidationError } from '@emporium/domain';
import { crmPermissions, type FileOperation } from '@emporium/shared';

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

/** BR-4: at most one open follow-up per lead, assignee and due date. */
export function assertFollowUpFree(exists: boolean): void {
  if (exists) {
    throw new ConflictError(
      'follow_up_exists',
      'This person already has an open follow-up on this lead for that date',
    );
  }
}

/**
 * BR-7: site visit photos follow the lead's permissions. Anyone who can read leads sees the
 * photos; adding or removing them needs the visit permission.
 */
export function canAccessVisitFile(request: {
  permissions: ReadonlySet<string>;
  operation: FileOperation;
  visitExists: boolean;
}): boolean {
  if (!request.visitExists) return false;
  return request.operation === 'read'
    ? request.permissions.has(crmPermissions.leadRead)
    : request.permissions.has(crmPermissions.visitManage);
}
