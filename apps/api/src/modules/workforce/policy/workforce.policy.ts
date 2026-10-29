import { ConflictError, ForbiddenError, NotFoundError, RuleViolationError } from '@emporium/domain';
import { hasScope, isScopeLimited, scopeFilter } from '@emporium/domain/identity';
import { workforcePermissions as perm } from '@emporium/shared';
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

/** The route is open to the holder of any one of the permissions. */
export function assertAny(caller: Pick<Caller, 'permissions'>, codes: readonly string[]): void {
  if (!codes.some((code) => caller.permissions.has(code))) {
    throw new ForbiddenError('forbidden', 'You do not have permission to do this');
  }
}

/** BR-7: pay information is for the holders of `workforce.rate.read` only. */
export const canReadRates = (caller: Pick<Caller, 'permissions'>): boolean =>
  caller.permissions.has(perm.rateRead);

/** BR-8: the full CNIC and bank details are for those who manage workers. */
export const canSeeSensitive = (caller: Pick<Caller, 'permissions'>): boolean =>
  caller.permissions.has(perm.workerManage);

/** Spec section 6: a supervisor reaches only the teams assigned to them; office roles reach any. */
export const canReachTeam = (caller: Pick<Caller, 'roles' | 'scopes'>, teamId: string): boolean =>
  hasScope(caller, 'team', teamId);

/** Someone who may not see a team gets "not found", as for any missing record. */
export function assertTeamReachable(caller: Pick<Caller, 'roles' | 'scopes'>, teamId: string) {
  if (!canReachTeam(caller, teamId)) throw new NotFoundError('team_not_found', 'Not found');
}

/** The teams a query must be limited to, or undefined for a caller who is not scope-limited. */
export function teamLimit(caller: Pick<Caller, 'roles' | 'scopes'>): readonly string[] | undefined {
  const filter = scopeFilter(caller, 'team');
  return filter.all ? undefined : filter.ids;
}

/**
 * A scope-limited caller (a supervisor) sees a worker only while the worker is in one of their
 * teams; anyone else gets "not found".
 */
export function assertWorkerReachable(
  caller: Pick<Caller, 'roles' | 'scopes'>,
  workerTeamIds: readonly string[],
): void {
  if (!isScopeLimited(caller)) return;
  if (!workerTeamIds.some((teamId) => canReachTeam(caller, teamId))) {
    throw new NotFoundError('worker_not_found', 'Not found');
  }
}

/** BR-5: the supervisor of a team is a user with the role `supervisor`. */
export function assertSupervisor(user: { roles: readonly string[] } | undefined): void {
  if (user === undefined || !user.roles.includes('supervisor')) {
    throw new RuleViolationError(
      'supervisor_invalid',
      'The supervisor must be a user with the supervisor role',
    );
  }
}

/** BR-1: a CNIC belongs to one active worker. */
export function assertCnicFree(holderId: string | undefined, selfId: string | undefined): void {
  if (holderId !== undefined && holderId !== selfId) {
    throw new ConflictError('cnic_in_use', 'An active worker already has this CNIC');
  }
}

/** Rates, teams and leaving apply to a worker who is still with the company. */
export function assertWorkerActive(status: string): void {
  if (status !== 'active') {
    throw new RuleViolationError('worker_inactive', 'The worker is no longer active');
  }
}

/** A trade or code in use is kept; the record is changed instead of removed. */
export function assertRemovable(inUse: boolean, code: string): void {
  if (inUse) {
    throw new RuleViolationError(code, 'The record is in use and cannot be removed');
  }
}
