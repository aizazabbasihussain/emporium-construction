import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@emporium/domain';
import { profitabilityPermissions } from '@emporium/shared';
import type { Actor, ProjectRef } from '../types.js';

/** Roles that see every project (BR-8); the project manager sees the projects they manage. */
const SEES_ALL = ['management', 'accountant', 'admin'] as const;

/** BR-8 and spec section 6: the permission to read; supervisors hold none. */
export function assertMayRead(actor: Pick<Actor, 'permissions'>): void {
  if (!actor.permissions.has(profitabilityPermissions.read)) {
    throw new ForbiddenError('forbidden', 'Not allowed to open project profitability');
  }
}

export function assertMaySetForecast(actor: Pick<Actor, 'permissions'>): void {
  if (!actor.permissions.has(profitabilityPermissions.forecastSet)) {
    throw new ForbiddenError('forbidden', 'Not allowed to set a cost-to-complete forecast');
  }
}

export function assertMayManageThresholds(actor: Pick<Actor, 'permissions'>): void {
  if (!actor.permissions.has(profitabilityPermissions.thresholdManage)) {
    throw new ForbiddenError('forbidden', 'Not allowed to manage the alert thresholds');
  }
}

/** BR-8: management and the accountant see every project; a project manager their own. */
export function canSeeProject(
  actor: Pick<Actor, 'roles' | 'userId'>,
  project: ProjectRef,
): boolean {
  return (
    SEES_ALL.some((role) => actor.roles.includes(role)) ||
    (project.projectManagerId !== null && project.projectManagerId === actor.userId)
  );
}

/** A project the caller may not see is reported as not found, like a missing one. */
export function assertProjectVisible(
  actor: Pick<Actor, 'roles' | 'userId'>,
  project: ProjectRef | undefined,
): asserts project is ProjectRef {
  if (project === undefined || !canSeeProject(actor, project)) {
    throw new NotFoundError('project_not_found', 'Not found');
  }
}

export function assertFound<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(`${what}_not_found`, 'Not found');
  return row;
}

/** BR-1: the cost-to-complete is money, zero or more. */
export function assertForecastAmount(amount: string): void {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new ValidationError('invalid_amount', 'The cost to complete must be zero or more');
  }
}

/** A threshold row belongs to the company or to one project, never both. */
export function assertScopeMatches(scope: string, projectId: string | undefined): void {
  if ((scope === 'company') !== (projectId === undefined)) {
    throw new ValidationError(
      'invalid_scope',
      'A company threshold has no project and a project threshold needs one',
    );
  }
}

export function assertThresholdFree(existing: unknown): void {
  if (existing !== undefined) {
    throw new ConflictError('threshold_exists', 'Thresholds already exist for this scope');
  }
}
