import { ConflictError, ForbiddenError, NotFoundError, RuleViolationError } from '@emporium/domain';
import { isEditable, type ReportStatus } from '@emporium/domain/dpr';
import { hasScope } from '@emporium/domain/identity';
import { dprPermissions as perm, type FileOperation } from '@emporium/shared';
import type { Actor } from '../types.js';

type Caller = Pick<Actor, 'userId' | 'roles' | 'scopes' | 'permissions'>;

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

/** BR-2: a supervisor reaches only the projects assigned to them; office roles reach any. */
export function assertProjectReachable(actor: Pick<Caller, 'roles' | 'scopes'>, projectId: string) {
  if (!hasScope(actor, 'project', projectId)) {
    throw new NotFoundError('project_not_found', 'Not found');
  }
}

/** A report is made on a project that is being run. */
export function assertProjectActive(status: string): void {
  if (status !== 'active') {
    throw new RuleViolationError(
      'project_not_active',
      'Reports can be made only on an active project',
    );
  }
}

/** BR-2: one report per author per project per date. */
export function assertReportAbsent(exists: boolean): void {
  if (exists) {
    throw new ConflictError('report_exists', 'You already have a report for this project and date');
  }
}

/** Spec section 6: reading needs `dpr.report.read` and, for a supervisor, the project in scope. */
export function canReadProject(caller: Caller, projectId: string): boolean {
  return caller.permissions.has(perm.reportRead) && hasScope(caller, 'project', projectId);
}

/** Someone who may not see a report gets "not found", as for any missing record. */
export function assertCanRead(caller: Caller, projectId: string): void {
  if (!canReadProject(caller, projectId)) {
    throw new NotFoundError('report_not_found', 'Not found');
  }
}

/** BR-5: only the author changes and submits their own report. */
export function assertAuthor(caller: Pick<Caller, 'userId'>, authorId: string): void {
  if (authorId !== caller.userId) {
    throw new ForbiddenError('not_your_report', 'Only the author can do this');
  }
}

/** The route is open to the holder of any one of the permissions. */
export function assertAny(caller: Pick<Caller, 'permissions'>, codes: readonly string[]): void {
  if (!codes.some((code) => caller.permissions.has(code))) {
    throw new ForbiddenError('forbidden', 'You do not have permission to do this');
  }
}

/**
 * Photos are files of entity type `dpr_report`: whoever may read the report reads them; the author
 * adds and removes them while the report can still be edited (BR-5).
 */
export function canAccessPhoto(request: {
  caller: Caller;
  operation: FileOperation;
  report: { projectId: string; authorId: string; status: ReportStatus } | undefined;
}): boolean {
  const { caller, operation, report } = request;
  if (report === undefined) return false;
  if (operation === 'read') return canReadProject(caller, report.projectId);
  return (
    report.authorId === caller.userId &&
    caller.permissions.has(perm.reportUpdateOwn) &&
    isEditable(report.status)
  );
}
