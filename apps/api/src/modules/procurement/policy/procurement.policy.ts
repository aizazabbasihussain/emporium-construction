import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { hasScope, isScopeLimited } from '@emporium/domain/identity';
import type { Destination } from '@emporium/domain/procurement';
import { procurementPermissions, type FileOperation } from '@emporium/shared';
import type { Actor, PurchaseOrderStatus, RequisitionStatus } from '../types.js';

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
 * BR-12: a supervisor raises requisitions and receipts only for the projects assigned to them, and
 * never for a store. Anyone who is not scope-limited reaches every destination.
 */
export function assertDestinationReachable(
  actor: Pick<Actor, 'roles' | 'scopes'>,
  destination: Destination,
): void {
  const reachable =
    destination.type === 'project'
      ? hasScope(actor, 'project', destination.id)
      : !isScopeLimited(actor);
  if (!reachable) throw new NotFoundError('destination_not_found', 'Not found');
}

/** BR-10: only vendors (party role vendor) and active parties. */
export function assertVendor(party: { roles: readonly string[]; status: string }): void {
  if (!party.roles.includes('vendor') || party.status !== 'active') {
    throw new RuleViolationError('not_a_vendor', 'The party is not an active vendor');
  }
}

/** BR-10: only active items. */
export function assertItemActive(active: boolean): void {
  if (!active) throw new RuleViolationError('item_inactive', 'An item on a line is not active');
}

export function assertCostCodeActive(active: boolean): void {
  if (!active) throw new RuleViolationError('cost_code_inactive', 'A cost code is not active');
}

export function assertRequisitionDraft(status: RequisitionStatus): void {
  if (status !== 'draft') {
    throw new RuleViolationError('requisition_read_only', 'Only a draft requisition can be edited');
  }
}

/** An RFQ or an order from selections needs an approved requisition. */
export function assertRequisitionOrderable(status: RequisitionStatus): void {
  if (status !== 'approved' && status !== 'partly_ordered') {
    throw new RuleViolationError(
      'requisition_not_approved',
      'The requisition must be approved before it can be sourced',
    );
  }
}

export function assertRfqOpen(status: string): void {
  if (status !== 'open') {
    throw new RuleViolationError('rfq_closed', 'The request for quotation is closed');
  }
}

export function assertInvited(invited: readonly string[], vendorId: string): void {
  if (!invited.includes(vendorId)) {
    throw new RuleViolationError('vendor_not_invited', 'The vendor was not invited to quote');
  }
}

export function assertPoDraft(status: PurchaseOrderStatus): void {
  if (status !== 'draft') {
    throw new RuleViolationError('po_read_only', 'Only a draft purchase order can be edited');
  }
}

/** BR-5: an approved order, or one already receiving, can be amended. */
export function assertPoAmendable(status: PurchaseOrderStatus): void {
  if (status !== 'approved' && status !== 'partly_received' && status !== 'received') {
    throw new RuleViolationError(
      'po_not_amendable',
      'Only an approved purchase order can be amended',
    );
  }
}

/** BR-9: closing is for orders that were approved. */
export function assertPoClosable(status: PurchaseOrderStatus): void {
  if (status !== 'approved' && status !== 'partly_received' && status !== 'received') {
    throw new RuleViolationError(
      'po_not_closable',
      'Only an approved purchase order can be closed',
    );
  }
}

/** An order with a posted receipt is closed, not cancelled. */
export function assertPoCancellable(hasReceipt: boolean): void {
  if (hasReceipt) {
    throw new RuleViolationError(
      'po_has_receipts',
      'An order with receipts cannot be cancelled; close it instead',
    );
  }
}

/** BR-8: stock issued from the receipt, or a bill that refers to it, blocks cancellation. */
export function assertGrnCancellable(blocks: { issued: boolean; billed: boolean }): void {
  if (blocks.issued) {
    throw new RuleViolationError(
      'grn_issued',
      'Stock from this receipt has been issued; it cannot be cancelled',
    );
  }
  if (blocks.billed) {
    throw new RuleViolationError(
      'grn_billed',
      'A vendor bill refers to this receipt; it cannot be cancelled',
    );
  }
}

/** BR-6: an order takes receipts only while it is approved or partly received. */
export function assertAcceptsReceipts(receivable: boolean): void {
  if (!receivable) {
    throw new RuleViolationError('po_not_receivable', 'This purchase order cannot take a receipt');
  }
}

/** The delivery challan photo (BR-11): whoever reads receipts sees it; adding needs create. */
export function canAccessGrnPhoto(request: {
  permissions: ReadonlySet<string>;
  operation: FileOperation;
  grnExists: boolean;
}): boolean {
  if (!request.grnExists) return false;
  return request.operation === 'read'
    ? request.permissions.has(procurementPermissions.grnRead)
    : request.permissions.has(procurementPermissions.grnCreate);
}
