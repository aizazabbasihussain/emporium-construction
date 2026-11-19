/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the cash book module. */
export const cashbookPermissions = {
  accountManage: 'cashbook.account.manage',
  txnRead: 'cashbook.txn.read',
  txnCreate: 'cashbook.txn.create',
  txnReverse: 'cashbook.txn.reverse',
  // The spec calls it `cashbook.reconcile`; a code needs three parts (identity constraint).
  reconcile: 'cashbook.reconciliation.manage',
} as const;

export type CashbookPermission = (typeof cashbookPermissions)[keyof typeof cashbookPermissions];

/** Spec P2-03 section 6: the accountant works; management manages accounts and reads. */
export const cashbookPermissionGrants: Record<CashbookPermission, readonly string[]> = {
  'cashbook.account.manage': ['admin', 'accountant', 'management'],
  'cashbook.txn.read': ['admin', 'accountant', 'management'],
  'cashbook.txn.create': ['admin', 'accountant'],
  'cashbook.txn.reverse': ['admin', 'accountant'],
  'cashbook.reconciliation.manage': ['admin', 'accountant'],
};

export const cashAccountKinds = ['cash', 'bank', 'petty_cash', 'wallet'] as const;
export type CashAccountKind = (typeof cashAccountKinds)[number];

export const cashDirections = ['in', 'out'] as const;
export type CashDirection = (typeof cashDirections)[number];

export const cashTxnTypes = [
  'receipt',
  'payment',
  'transfer_in',
  'transfer_out',
  'bank_charge',
  'advance',
  'other',
] as const;
export type CashTxnType = (typeof cashTxnTypes)[number];

export const cashMethods = ['cash', 'cheque', 'bank_transfer', 'online', 'wallet'] as const;
export type CashMethod = (typeof cashMethods)[number];

export const reconciliationStatusValues = ['draft', 'completed'] as const;
export type ReconciliationStatusValue = (typeof reconciliationStatusValues)[number];

export const pendingSourceStatuses = ['pending', 'recorded'] as const;
export type PendingSourceStatus = (typeof pendingSourceStatuses)[number];

/** Approval document type of a payment request (H-09); the owner approves every one. */
export const paymentDocType = 'payment';

/** Number series of the cash book (gapless: a transaction number is never reused). */
export const cashbookSeries = 'cash_txn';

/** Settings of the accountant. */
export const cashbookSettingKeys = {
  /** Payments above this amount need an approved payment request (BR-5); 0 means every payment (H-09). */
  paymentApprovalThreshold: 'cashbook.payment_approval_threshold',
  /** The account that custodian advances are paid from (BR-6); empty leaves them for the accountant to choose. */
  advanceAccountId: 'cashbook.advance_account_id',
} as const;
