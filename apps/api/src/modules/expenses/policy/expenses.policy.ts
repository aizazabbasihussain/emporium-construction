import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { hasScope } from '@emporium/domain/identity';
import { expensesPermissions as perm, type FileOperation } from '@emporium/shared';
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

export function assertApplied(applied: boolean): void {
  if (!applied) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
}

/** BR-2: a supervisor reaches only the projects assigned to them; office roles reach any. */
export function assertProjectReachable(actor: Pick<Caller, 'roles' | 'scopes'>, projectId: string) {
  if (!hasScope(actor, 'project', projectId)) {
    throw new NotFoundError('project_not_found', 'Not found');
  }
}

/** BR-2: a project line needs an active project. */
export function assertProjectActive(status: string): void {
  if (status !== 'active') {
    throw new RuleViolationError(
      'project_not_active',
      'Expenses can be claimed only on an active project',
    );
  }
}

export function assertCostCodeActive(active: boolean): void {
  if (!active) {
    throw new RuleViolationError('cost_code_inactive', 'The cost code is not active');
  }
}

/** A line names a category that exists. */
export function assertCategoryKnown(known: boolean): void {
  if (!known) throw new ValidationError('category_unknown', 'A line names an unknown category');
}

/** BR-3: a receipt reference must be a file attached to this claim. */
export function assertReceiptKnown(known: boolean): void {
  if (!known) {
    throw new ValidationError('receipt_unknown', 'A receipt is not attached to this claim');
  }
}

/** Own claims for claimants, every claim for finance and management (spec section 6). */
export function canReadClaim(caller: Pick<Caller, 'userId' | 'permissions'>, claimantId: string) {
  if (caller.permissions.has(perm.claimReadAll)) return true;
  return (
    claimantId === caller.userId &&
    (caller.permissions.has(perm.claimReadOwn) || caller.permissions.has(perm.claimCreate))
  );
}

/** Someone who may not see a claim gets "not found", as for any missing record. */
export function assertCanReadClaim(caller: Caller, claimantId: string): void {
  if (!canReadClaim(caller, claimantId)) {
    throw new NotFoundError('claim_not_found', 'Not found');
  }
}

/** Only the claimant changes and submits their own claim. */
export function assertOwnClaim(caller: Pick<Caller, 'userId'>, claimantId: string): void {
  if (claimantId !== caller.userId) {
    throw new ForbiddenError('not_your_claim', 'Only the claimant can do this');
  }
}

/** BR-7: the claimant cancels their own claim; the accountant (who may reverse) any claim. */
export function assertCanCancel(
  caller: Pick<Caller, 'userId' | 'permissions'>,
  claimantId: string,
) {
  if (claimantId !== caller.userId && !caller.permissions.has(perm.claimReverse)) {
    throw new ForbiddenError('not_your_claim', 'Only the claimant or the accountant can cancel');
  }
}

/** Whether the caller holds at least one of the permissions. */
export function assertAny(caller: Pick<Caller, 'permissions'>, codes: readonly string[]): void {
  if (!codes.some((code) => caller.permissions.has(code))) {
    throw new ForbiddenError('forbidden', 'You do not have permission to do this');
  }
}

/** Advances and custodian balances: finance sees all, a claimant sees their own. */
export function canSeeAllCustodians(caller: Pick<Caller, 'permissions'>): boolean {
  return caller.permissions.has(perm.claimReadAll) || caller.permissions.has(perm.advanceIssue);
}

export function assertCanReadBalance(
  caller: Pick<Caller, 'userId' | 'permissions'>,
  custodianId: string,
): void {
  if (!canSeeAllCustodians(caller) && custodianId !== caller.userId) {
    throw new NotFoundError('custodian_not_found', 'Not found');
  }
}

/** BR-8: an advance goes to a registered custodian who is active. */
export function assertCustodianUsable(custodian: { active: boolean } | undefined): void {
  if (custodian === undefined) {
    throw new NotFoundError('custodian_not_found', 'The custodian is not registered');
  }
  if (!custodian.active) {
    throw new RuleViolationError('custodian_inactive', 'The custodian is not active');
  }
}

/** A draft can be deleted; anything later is cancelled instead (constitution 5.3). */
export function assertDraftOnly(status: string): void {
  if (status !== 'draft') {
    throw new RuleViolationError(
      'claim_not_draft',
      'Only a draft claim can be deleted; cancel it instead',
    );
  }
}

/** BR-7: a posted claim is reversed by the accountant, not cancelled. */
export function assertCancelable(status: string): void {
  if (status === 'posted') {
    throw new RuleViolationError(
      'claim_posted',
      'A posted claim can only be reversed by the accountant',
    );
  }
}

/** BR-7: only a posted claim is reversed. */
export function assertReversible(status: string): void {
  if (status !== 'posted') {
    throw new RuleViolationError('claim_not_posted', 'Only a posted claim can be reversed');
  }
}

/** A custodian is a person with an account. */
export function assertUserKnown(known: boolean): void {
  if (!known) throw new ValidationError('user_unknown', 'The user does not exist or is not active');
}

/**
 * Receipts are files of entity type `exp_claim`: the claimant reads and changes them on their own
 * claim; anyone who may read all claims reads them.
 */
export function canAccessReceipt(request: {
  userId: string;
  permissions: ReadonlySet<string>;
  operation: FileOperation;
  claimantId: string | undefined;
}): boolean {
  if (request.claimantId === undefined) return false;
  if (request.operation === 'read') {
    return canReadClaim(request, request.claimantId);
  }
  return request.claimantId === request.userId && request.permissions.has(perm.claimCreate);
}
