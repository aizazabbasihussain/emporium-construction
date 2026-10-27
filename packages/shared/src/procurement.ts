/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the procurement module. */
export const procurementPermissions = {
  requisitionCreate: 'procurement.requisition.create',
  requisitionRead: 'procurement.requisition.read',
  rfqManage: 'procurement.rfq.manage',
  poCreate: 'procurement.po.create',
  poRead: 'procurement.po.read',
  poAmend: 'procurement.po.amend',
  poClose: 'procurement.po.close',
  grnCreate: 'procurement.grn.create',
  grnRead: 'procurement.grn.read',
  grnCancel: 'procurement.grn.cancel',
} as const;

export type ProcurementPermission =
  (typeof procurementPermissions)[keyof typeof procurementPermissions];

const requesters = ['supervisor', 'project_manager', 'storekeeper', 'procurement'] as const;
const receivers = ['storekeeper', 'supervisor'] as const;

/** Roles that receive each permission (spec P1-11 section 6). Management may read everything. */
export const procurementPermissionGrants: Record<ProcurementPermission, readonly string[]> = {
  'procurement.requisition.create': requesters,
  'procurement.requisition.read': [...requesters, 'management'],
  'procurement.rfq.manage': ['procurement'],
  'procurement.po.create': ['procurement'],
  'procurement.po.read': ['procurement', 'management'],
  'procurement.po.amend': ['procurement'],
  'procurement.po.close': ['procurement'],
  'procurement.grn.create': receivers,
  'procurement.grn.read': [...receivers, 'procurement', 'management'],
  'procurement.grn.cancel': receivers,
};

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

export const grnStatuses = ['posted', 'cancelled'] as const;
export type GrnStatus = (typeof grnStatuses)[number];

export const destinationTypes = ['project', 'store'] as const;
export type DestinationType = (typeof destinationTypes)[number];

/** Approval document types (H-09 matrix) and the file entity type of the delivery challan photo. */
export const requisitionDocType = 'requisition';
export const purchaseOrderDocType = 'purchase_order';
export const grnEntityType = 'prc_grn';

export const procurementSettingKeys = {
  grnPhotoRequired: 'procurement.grn_photo_required',
  overReceiptTolerancePercent: 'procurement.over_receipt_tolerance_percent',
} as const;
