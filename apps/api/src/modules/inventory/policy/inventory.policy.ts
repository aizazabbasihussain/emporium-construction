import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { hasScope, isScopeLimited } from '@emporium/domain/identity';
import { inventoryPermissions } from '@emporium/shared';
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

/**
 * Spec section 6: a supervisor reaches only the stores of the projects assigned to them, and never a
 * warehouse. Anyone who is not scope-limited reaches every store. An unreachable store looks absent.
 */
export function assertStoreReachable(
  actor: Pick<Actor, 'roles' | 'scopes'>,
  store: { projectId: string | null },
): void {
  const reachable =
    store.projectId === null ? !isScopeLimited(actor) : hasScope(actor, 'project', store.projectId);
  if (!reachable) throw new NotFoundError('store_not_found', 'Not found');
}

/**
 * Spec section 6: the storekeeper issues; a supervisor issues only on the stores of assigned
 * projects and only while the setting `supervisor_can_issue` is on.
 */
export function assertMayIssue(
  actor: Pick<Actor, 'roles' | 'permissions'>,
  supervisorCanIssue: boolean,
): void {
  if (actor.permissions.has(inventoryPermissions.stockIssue)) return;
  if (isScopeLimited(actor) && supervisorCanIssue) return;
  throw new ForbiddenError('forbidden', 'You are not allowed to issue material');
}

export function assertStoreActive(active: boolean): void {
  if (!active) throw new RuleViolationError('store_inactive', 'The store is not active');
}

/** Only stockable items have stock. */
export function assertStockable(item: { stockable: boolean; active: boolean }): void {
  if (!item.stockable) {
    throw new RuleViolationError('item_not_stockable', 'The item is not a stock item');
  }
  if (!item.active) throw new RuleViolationError('item_inactive', 'The item is not active');
}

/** BR-3: neither the command nor the item names a cost code, so the cost cannot be placed. */
export function assertCostCodeKnown(costCodeId: string | null): string {
  if (costCodeId === null) {
    throw new RuleViolationError(
      'cost_code_required',
      'Name a cost code for this issue, or set a default cost code on the item',
    );
  }
  return costCodeId;
}

/** BR-3: stock is issued to a project that is open for costs. */
export function assertProjectOpen(status: string): void {
  if (status !== 'planning' && status !== 'active') {
    throw new RuleViolationError('project_not_open', 'The project is not open for costs');
  }
}

/** BR-8: adjustments are refused until the loss cost code is configured. */
export function assertLossCostCode(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new RuleViolationError(
      'stock_loss_cost_code_missing',
      'Set the setting stock_loss_cost_code before stock adjustments are allowed',
    );
  }
  return value;
}

/** BR-4: both legs of a transfer name different stores. */
export function assertDifferentStores(from: string, to: string): void {
  if (from === to) {
    throw new ValidationError('same_store', 'A transfer needs two different stores');
  }
}

/** BR-5: client-owned stock names the client it belongs to; company stock names nobody. */
export function assertOwnerMatches(ownership: string, ownerPartyId: string | null): void {
  if (ownership === 'client' && ownerPartyId === null) {
    throw new ValidationError('owner_required', 'Client-owned stock needs the owner party');
  }
  if (ownership === 'company' && ownerPartyId !== null) {
    throw new ValidationError('owner_not_allowed', 'Company stock has no owner party');
  }
}

/** BR-5: the owner of client material must be a client party. */
export function assertClient(party: { roles: readonly string[] } | undefined): void {
  if (party === undefined || !party.roles.includes('client')) {
    throw new ValidationError('client_not_found', 'The owner is not a client');
  }
}
