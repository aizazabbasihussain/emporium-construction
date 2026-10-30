import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { hasScope, isScopeLimited } from '@emporium/domain/identity';
import type { Actor } from '../types.js';

type Caller = Pick<Actor, 'roles' | 'scopes'>;

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

/** BR-1: a supervisor reaches only their own teams; office roles reach any. Others get "not found". */
export function assertTeamReachable(caller: Caller, teamId: string): void {
  if (!hasScope(caller, 'team', teamId)) throw new NotFoundError('team_not_found', 'Not found');
}

/** BR-3: allocations go to projects the supervisor is scoped to. */
export function assertProjectReachable(caller: Caller, projectId: string): void {
  if (!hasScope(caller, 'project', projectId)) {
    throw new NotFoundError('project_not_found', 'Not found');
  }
}

/** BR-3: cost goes to an active project only. */
export function assertProjectActive(status: string): void {
  if (status !== 'active') {
    throw new RuleViolationError(
      'project_not_active',
      'Attendance can be allocated only to an active project',
    );
  }
}

export function assertCostCodeActive(active: boolean): void {
  if (!active) throw new RuleViolationError('cost_code_inactive', 'The cost code is not active');
}

/** BR-3: the default cost code is a setting; it must name a code that exists. */
export function assertLabourCodeKnown<T>(code: T | undefined): T {
  if (code === undefined) {
    throw new RuleViolationError(
      'labour_cost_code_unknown',
      'The setting labour_cost_code names no cost code',
    );
  }
  return code;
}

export function assertTeamActive(active: boolean): void {
  if (!active) throw new RuleViolationError('team_inactive', 'The team is no longer active');
}

/** BR-2: only workers who belong to the team on the date can be on its sheet. */
export function assertMembers(names: readonly string[]): void {
  if (names.length > 0) {
    throw new RuleViolationError(
      'worker_not_in_team',
      `Not members of the team on this date: ${names.join(', ')}`,
    );
  }
}

/** BR-2: a worker is on one sheet at most per date. */
export function assertWorkersFree(names: readonly string[]): void {
  if (names.length > 0) {
    throw new RuleViolationError(
      'worker_on_other_sheet',
      `Already on another sheet for this date: ${names.join(', ')}`,
    );
  }
}

/** BR-4: a missing pay rate blocks submission and names the worker. */
export function missingRate(workerName: string, date: string): RuleViolationError {
  return new RuleViolationError(
    'worker_rate_missing',
    `${workerName} has no pay rate in effect on ${date}`,
  );
}

/** H-11: the overtime multiplier setting must be a positive number. */
export function assertMultiplier(value: string): string {
  if (!/^\d{1,2}(\.\d{1,4})?$/.test(value.trim()) || Number(value) <= 0) {
    throw new RuleViolationError(
      'overtime_multiplier_invalid',
      'The overtime multiplier setting is not a positive number',
    );
  }
  return value.trim();
}

/** BR-7: a sheet cannot be unlocked once the wage period of its month is approved. */
export function assertWagePeriodOpen(approvedPeriod: string | null): void {
  if (approvedPeriod !== null) {
    throw new RuleViolationError(
      'wage_period_approved',
      `The wage period ${approvedPeriod} is approved; its attendance can no longer be unlocked`,
    );
  }
}

/** A sheet that has been created is saved with the version the caller saw. */
export function assertVersionGiven(version: number | undefined): number {
  if (version === undefined) {
    throw new ConflictError('version_conflict', 'The sheet exists; send its version to change it');
  }
  return version;
}

export function assertReason(reason: string): string {
  const text = reason.trim();
  if (text === '') throw new ValidationError('reason_required', 'A reason is required');
  return text;
}

/** The route is open to the holder of any one of the permissions. */
export function assertAny(caller: Pick<Actor, 'permissions'>, codes: readonly string[]): void {
  if (!codes.some((code) => caller.permissions.has(code))) {
    throw new ForbiddenError('forbidden', 'You do not have permission to do this');
  }
}

/** Workforce BR-7: a supervisor never receives pay information; everyone else may see cost. */
export const canSeeCost = (caller: Caller): boolean => !isScopeLimited(caller);
