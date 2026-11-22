import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@emporium/domain';
import { accountingPermissions } from '@emporium/shared';
import type { Actor } from '../types.js';

type Caller = Pick<Actor, 'permissions'>;

/** BR-8: every export needs the permission to run it. */
export function assertMayRun(actor: Caller): void {
  if (!actor.permissions.has(accountingPermissions.exportRun)) {
    throw new ForbiddenError('forbidden', 'Not allowed to run accountant exports');
  }
}

/** The hub and the history are open to whoever may read or run exports. */
export function assertMayRead(actor: Caller): void {
  if (
    !actor.permissions.has(accountingPermissions.exportRead) &&
    !actor.permissions.has(accountingPermissions.exportRun)
  ) {
    throw new ForbiddenError('forbidden', 'Not allowed to open the accountant exports');
  }
}

/** The queue, the rules and the chart are open to anyone who holds an accounting permission. */
export function assertMayView(actor: Caller): void {
  if (!Object.values(accountingPermissions).some((code) => actor.permissions.has(code))) {
    throw new ForbiddenError('forbidden', 'Not allowed to open accounting tags');
  }
}

export function assertMayTag(actor: Caller): void {
  if (!actor.permissions.has(accountingPermissions.tagManage)) {
    throw new ForbiddenError('forbidden', 'Not allowed to tag documents');
  }
}

export function assertMayManageRules(actor: Caller): void {
  if (!actor.permissions.has(accountingPermissions.rulesManage)) {
    throw new ForbiddenError('forbidden', 'Not allowed to manage the mapping rules');
  }
}

export function assertFound<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(`${what}_not_found`, 'Not found');
  return row;
}

/** A tag or a rule may only name an account that exists in the chart and is active. */
export function assertAccountUsable(account: { active: boolean } | undefined, code: string): void {
  if (account === undefined) {
    throw new ValidationError('unknown_account', `There is no account ${code}`);
  }
  if (!account.active) {
    throw new ValidationError('inactive_account', `Account ${code} is switched off`);
  }
}

/** The period of an export: both dates given and in order. */
export function assertPeriod(from: string, to: string): void {
  if (from > to) {
    throw new ValidationError('invalid_period', 'The period starts after it ends');
  }
}

/** An update that finds no row of the expected version lost a race. */
export function assertVersionMatched<T>(row: T | undefined): T {
  if (row === undefined) {
    throw new ConflictError('version_conflict', 'It was changed by someone else; reload and retry');
  }
  return row;
}
