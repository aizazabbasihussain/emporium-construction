import { ForbiddenError, NotFoundError, RuleViolationError } from '@emporium/domain';
import { scopeFilter } from '@emporium/domain/identity';
import { reportPermission } from '@emporium/shared';
import type { Actor, ReportCode } from '../types.js';

/** BR-8: a report opens only for the roles that hold its permission. Supervisors hold none. */
export function assertMayRead(actor: Pick<Actor, 'permissions'>, code: ReportCode): void {
  if (!actor.permissions.has(reportPermission[code])) {
    throw new ForbiddenError('forbidden', `Not allowed to open the ${code} report`);
  }
}

/** BR-8: the projects a scope-limited caller reaches; undefined when the caller reaches all. */
export function scopedProjectIds(
  actor: Pick<Actor, 'roles' | 'scopes'>,
): readonly string[] | undefined {
  const scope = scopeFilter(actor, 'project');
  return scope.all ? undefined : scope.ids;
}

/** BR-8: a project the caller does not reach is reported as not found, like a missing one. */
export function assertProjectReachable(
  reach: readonly string[] | undefined,
  projectId: string | undefined,
): void {
  if (projectId !== undefined && reach !== undefined && !reach.includes(projectId)) {
    throw new NotFoundError('project_not_found', 'Not found');
  }
}

/** BR-10: an export of more than the limit is refused with a message to narrow the filters. */
export function assertExportable(rows: number, limit: number): void {
  if (rows > limit) {
    throw new RuleViolationError(
      'export_too_large',
      `The export has ${rows} rows and the limit is ${limit}; narrow the filters and try again`,
    );
  }
}

/** A saved filter belongs to the user who made it; anyone else is told it does not exist. */
export function assertOwnFilter<T extends { user_id: string }>(
  row: T | undefined,
  userId: string,
): asserts row is T {
  if (row === undefined || row.user_id !== userId) {
    throw new NotFoundError('saved_filter_not_found', 'Not found');
  }
}
