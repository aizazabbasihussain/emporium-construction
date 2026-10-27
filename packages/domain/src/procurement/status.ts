import { RuleViolationError } from '../errors.js';

export const requisitionStatuses = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'partly_ordered',
  'ordered',
  'cancelled',
] as const;
export type RequisitionStatus = (typeof requisitionStatuses)[number];

/** Constitution 5.8: the allowed requisition transitions as an explicit table. */
export const requisitionTransitions: Record<RequisitionStatus, readonly RequisitionStatus[]> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'draft', 'cancelled'],
  approved: ['partly_ordered', 'ordered', 'cancelled'],
  rejected: [],
  partly_ordered: ['approved', 'ordered'],
  ordered: ['approved', 'partly_ordered'],
  cancelled: [],
};

export function assertRequisitionTransition(from: RequisitionStatus, to: RequisitionStatus): void {
  if (!requisitionTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'requisition_transition',
      `A requisition cannot go from ${from} to ${to}`,
    );
  }
}

export const purchaseOrderStatuses = [
  'draft',
  'pending_approval',
  'approved',
  'partly_received',
  'received',
  'closed',
  'cancelled',
] as const;
export type PurchaseOrderStatus = (typeof purchaseOrderStatuses)[number];

/**
 * Constitution 5.8: the allowed purchase order transitions. An approved order returns to `draft`
 * when it is amended (BR-5); receipts move it between approved, partly received and received, and
 * cancelling a receipt moves it back.
 */
export const purchaseOrderTransitions: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> =
  {
    draft: ['pending_approval', 'cancelled'],
    pending_approval: ['approved', 'partly_received', 'received', 'draft', 'cancelled'],
    approved: ['partly_received', 'received', 'draft', 'closed', 'cancelled'],
    partly_received: ['approved', 'received', 'draft', 'closed'],
    received: ['approved', 'partly_received', 'draft', 'closed'],
    closed: [],
    cancelled: [],
  };

export function assertPoTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): void {
  if (!purchaseOrderTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'po_transition',
      `A purchase order cannot go from ${from} to ${to}`,
    );
  }
}

export const grnStatuses = ['posted', 'cancelled'] as const;
export type GrnStatus = (typeof grnStatuses)[number];

export const grnTransitions: Record<GrnStatus, readonly GrnStatus[]> = {
  posted: ['cancelled'],
  cancelled: [],
};

export function assertGrnTransition(from: GrnStatus, to: GrnStatus): void {
  if (!grnTransitions[from].includes(to)) {
    throw new RuleViolationError('grn_transition', `A receipt cannot go from ${from} to ${to}`);
  }
}

/** BR-6: orders in these statuses can take a receipt. */
export const isReceivable = (status: PurchaseOrderStatus): boolean =>
  status === 'approved' || status === 'partly_received';
