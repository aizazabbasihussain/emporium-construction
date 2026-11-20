/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the receivables module. */
export const receivablesPermissions = {
  receiptCreate: 'receivables.receipt.create',
  receiptCancel: 'receivables.receipt.cancel',
  pdcManage: 'receivables.pdc.manage',
  ledgerRead: 'receivables.ledger.read',
  adjustmentCreate: 'receivables.adjustment.create',
} as const;

export type ReceivablesPermission =
  (typeof receivablesPermissions)[keyof typeof receivablesPermissions];

/** Spec P2-04 section 6: the accountant works; management reads the ledger. */
export const receivablesPermissionGrants: Record<ReceivablesPermission, readonly string[]> = {
  'receivables.receipt.create': ['admin', 'accountant'],
  'receivables.receipt.cancel': ['admin', 'accountant'],
  'receivables.pdc.manage': ['admin', 'accountant'],
  'receivables.ledger.read': ['admin', 'accountant', 'management'],
  'receivables.adjustment.create': ['admin', 'accountant'],
};

export const receiptMethods = ['cash', 'cheque', 'bank_transfer', 'online', 'pdc'] as const;
export type ReceiptMethod = (typeof receiptMethods)[number];

export const receiptStatuses = [
  'recorded',
  'pending_clearing',
  'cleared',
  'bounced',
  'cancelled',
] as const;
export type ReceiptStatus = (typeof receiptStatuses)[number];

export const allocationKinds = ['invoice', 'advance', 'withholding'] as const;
export type AllocationKind = (typeof allocationKinds)[number];

export const pdcStatuses = [
  'received',
  'deposited',
  'cleared',
  'bounced',
  'returned',
  'replaced',
] as const;
export type PdcStatus = (typeof pdcStatuses)[number];

export const pdcActions = ['deposit', 'clear', 'bounce', 'return', 'replace'] as const;
export type PdcAction = (typeof pdcActions)[number];

export const followupStatuses = ['open', 'done'] as const;
export type FollowupStatus = (typeof followupStatuses)[number];

/** Approval document type of a small-balance write-off (BR-11, H-09). */
export const writeOffDocType = 'write_off';

/** Settings of the accountant and the owner. */
export const receivablesSettingKeys = {
  /** Largest balance (PKR) that may be written off with approval (BR-11); 0 allows none. */
  smallBalanceLimit: 'receivables.small_balance_limit',
  /** Withholding difference (PKR) above which the accountant is told (BR-4). */
  withholdingTolerance: 'receivables.withholding_tolerance',
  /** H-30: upper day limits of the aging buckets, comma separated; the last bucket is open-ended. */
  agingBuckets: 'receivables.aging_buckets',
} as const;

export const receivablesNotificationTemplates = {
  'pdc.bounced': 'notifications.templates.pdcBounced',
  'pdc.upcoming': 'notifications.templates.pdcUpcoming',
} as const;

/** The existing H-27 series `RV` is used for receipt numbers. */
export const receiptSeries = 'receipt_voucher';
