/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the inventory module. */
export const inventoryPermissions = {
  stockRead: 'inventory.stock.read',
  stockIssue: 'inventory.stock.issue',
  stockReturn: 'inventory.stock.return',
  stockTransfer: 'inventory.stock.transfer',
  stockCount: 'inventory.stock.count',
  adjustmentApprove: 'inventory.adjustment.approve',
  storeManage: 'inventory.store.manage',
} as const;

export type InventoryPermission = (typeof inventoryPermissions)[keyof typeof inventoryPermissions];

const keepers = ['storekeeper'] as const;

/** Roles that receive each permission (spec P1-12 section 6). A supervisor issues only through a setting. */
export const inventoryPermissionGrants: Record<InventoryPermission, readonly string[]> = {
  'inventory.stock.read': [
    'storekeeper',
    'procurement',
    'project_manager',
    'management',
    'accountant',
    'supervisor',
  ],
  'inventory.stock.issue': keepers,
  'inventory.stock.return': keepers,
  'inventory.stock.transfer': keepers,
  'inventory.stock.count': keepers,
  'inventory.adjustment.approve': ['management'],
  'inventory.store.manage': ['admin', 'storekeeper'],
};

export const inventoryMovementTypes = [
  'receipt',
  'issue',
  'transfer_out',
  'transfer_in',
  'adjustment_in',
  'adjustment_out',
  'return_in',
  'salvage_in',
  'client_receipt',
  'client_return',
] as const;
export type InventoryMovementType = (typeof inventoryMovementTypes)[number];

export const ownerships = ['company', 'client'] as const;
export type Ownership = (typeof ownerships)[number];

export const storeKinds = ['warehouse', 'site'] as const;
export type StoreKind = (typeof storeKinds)[number];

export const transferStatuses = ['draft', 'in_transit', 'received', 'cancelled'] as const;
export type TransferStatus = (typeof transferStatuses)[number];

export const countStatuses = ['draft', 'counted', 'approved', 'cancelled'] as const;
export type CountStatus = (typeof countStatuses)[number];

/** The approval document type of a count adjustment (H-09 matrix). */
export const stockAdjustmentDocType = 'stock_adjustment';

export const inventorySettingKeys = {
  allowNegativeStock: 'inventory.allow_negative_stock',
  stockLossCostCode: 'inventory.stock_loss_cost_code',
  supervisorCanIssue: 'inventory.supervisor_can_issue',
  salvageValueMode: 'inventory.salvage_value_mode',
} as const;

export const salvageValueModes = ['zero', 'estimated'] as const;
export type SalvageValueMode = (typeof salvageValueModes)[number];

export const inventoryNotificationTemplates = {
  'inventory.reorder.low': 'notifications.templates.inventoryReorderLow',
} as const;
