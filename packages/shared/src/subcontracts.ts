/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the subcontracts module. */
export const subcontractsPermissions = {
  orderRead: 'subcontracts.order.read',
  orderCreate: 'subcontracts.order.create',
  orderUpdate: 'subcontracts.order.update',
  orderClose: 'subcontracts.order.close',
  certificateCreate: 'subcontracts.certificate.create',
  /** Sending a certificate for approval (a supervisor only drafts it). */
  certificateSubmit: 'subcontracts.certificate.submit',
  /** Turning a certified certificate into a vendor bill (the accountant's step, BR-5). */
  certificateBill: 'subcontracts.certificate.bill',
  /** Deciding a variation of a work order (BR-1). */
  variationApprove: 'subcontracts.variation.approve',
  /** BR-9: without it the amount fields of a work order are hidden. */
  amountRead: 'subcontracts.amount.read',
} as const;

export type SubcontractsPermission =
  (typeof subcontractsPermissions)[keyof typeof subcontractsPermissions];

/**
 * Spec P2-06 section 6: project managers and management work the orders, the accountant reads and
 * bills, supervisors see the orders of their projects and draft certificates.
 */
export const subcontractsPermissionGrants: Record<SubcontractsPermission, readonly string[]> = {
  'subcontracts.order.read': ['admin', 'project_manager', 'management', 'accountant', 'supervisor'],
  'subcontracts.order.create': ['admin', 'project_manager', 'management'],
  'subcontracts.order.update': ['admin', 'project_manager', 'management'],
  'subcontracts.order.close': ['admin', 'project_manager', 'management'],
  'subcontracts.certificate.create': ['admin', 'project_manager', 'supervisor'],
  'subcontracts.certificate.submit': ['admin', 'project_manager'],
  'subcontracts.certificate.bill': ['admin', 'accountant'],
  'subcontracts.variation.approve': ['admin', 'management'],
  'subcontracts.amount.read': ['admin', 'management', 'accountant', 'project_manager'],
};

export const workOrderStatuses = [
  'draft',
  'pending_approval',
  'active',
  'completed',
  'closed',
  'cancelled',
] as const;
export type WorkOrderStatus = (typeof workOrderStatuses)[number];

export const certificateStatuses = [
  'draft',
  'pending_approval',
  'certified',
  'billed',
  'cancelled',
] as const;
export type CertificateStatus = (typeof certificateStatuses)[number];

export const certificateBases = ['percent_complete', 'amount'] as const;
export type CertificateBasis = (typeof certificateBases)[number];

export const subVariationStatuses = ['draft', 'approved', 'rejected'] as const;
export type SubVariationStatus = (typeof subVariationStatuses)[number];

/** Approval document types (BR-1, BR-4). */
export const subcontractOrderDocType = 'subcontract_order';
export const subcontractCertificateDocType = 'subcontract_certificate';

/** The number series of orders and certificates. */
export const subcontractOrderSeries = 'subcontract_order';
export const subcontractCertificateSeries = 'subcontract_certificate';

/** The bill source this module registers with payables (BR-5). */
export const subcontractBillSource = 'subcontract';
