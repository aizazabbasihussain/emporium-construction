/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the payables module. */
export const payablesPermissions = {
  billCreate: 'payables.bill.create',
  billRead: 'payables.bill.read',
  billPost: 'payables.bill.post',
  // The spec writes `override-match`; permission codes allow only [a-z0-9_] (migration 0002).
  billOverrideMatch: 'payables.bill.override_match',
  paymentCreate: 'payables.payment.create',
  paymentPay: 'payables.payment.pay',
  ledgerRead: 'payables.ledger.read',
} as const;

export type PayablesPermission = (typeof payablesPermissions)[keyof typeof payablesPermissions];

/** Spec P2-05 section 6: the accountant works, procurement enters and reads bills, management reads. */
export const payablesPermissionGrants: Record<PayablesPermission, readonly string[]> = {
  'payables.bill.create': ['admin', 'accountant', 'procurement'],
  'payables.bill.read': ['admin', 'accountant', 'procurement'],
  'payables.bill.post': ['admin', 'accountant'],
  'payables.bill.override_match': ['admin', 'accountant'],
  'payables.payment.create': ['admin', 'accountant'],
  'payables.payment.pay': ['admin', 'accountant'],
  'payables.ledger.read': ['admin', 'accountant', 'management'],
};

export const billSourceTypes = ['purchase', 'subcontract', 'expense_other', 'opening'] as const;
export type BillSourceType = (typeof billSourceTypes)[number];

export const billStatuses = [
  'draft',
  'matched',
  'pending_approval',
  'approved',
  'posted',
  'partly_paid',
  'paid',
  'cancelled',
] as const;
export type BillStatus = (typeof billStatuses)[number];

export const paymentMethods = ['cash', 'cheque', 'bank_transfer', 'online'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const paymentStatuses = [
  'draft',
  'pending_approval',
  'approved',
  'paid',
  'cancelled',
] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export const varianceTreatments = ['project_cost', 'overhead_cost'] as const;
export type VarianceTreatment = (typeof varianceTreatments)[number];

/** Approval document type of a vendor bill (BR-4); payments use the cash book's `payment`. */
export const vendorBillDocType = 'vendor_bill';

/** The number series of bills; payments use the existing H-27 series `payment_voucher`. */
export const billSeries = 'vendor_bill';
export const paymentSeries = 'payment_voucher';

export const payablesSettingKeys = {
  /** H-23: quantity above what was received and not yet billed that still matches, in percent. */
  qtyTolerancePercent: 'payables.match_qty_tolerance_percent',
  /** H-23: billed rate above or below the order rate that still matches, in percent. */
  rateTolerancePercent: 'payables.match_rate_tolerance_percent',
  /** H-22: the overhead cost code (its code) that takes a price variance on goods still in stock. */
  priceVarianceCostCode: 'payables.price_variance_cost_code',
} as const;
