/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the billing module. */
export const billingPermissions = {
  scheduleRead: 'billing.schedule.read',
  scheduleManage: 'billing.schedule.manage',
  invoiceRead: 'billing.invoice.read',
  invoiceCreate: 'billing.invoice.create',
  invoiceIssue: 'billing.invoice.issue',
  creditNoteCreate: 'billing.creditnote.create',
  advanceManage: 'billing.advance.manage',
} as const;

export type BillingPermission = (typeof billingPermissions)[keyof typeof billingPermissions];

/** Spec P2-02 section 6: the accountant works; management reads (and approves through the engine). */
export const billingPermissionGrants: Record<BillingPermission, readonly string[]> = {
  'billing.schedule.read': ['admin', 'accountant', 'management'],
  'billing.schedule.manage': ['admin', 'accountant'],
  'billing.invoice.read': ['admin', 'accountant', 'management'],
  'billing.invoice.create': ['admin', 'accountant'],
  'billing.invoice.issue': ['admin', 'accountant'],
  'billing.creditnote.create': ['admin', 'accountant'],
  'billing.advance.manage': ['admin', 'accountant'],
};

export const invoiceStatuses = [
  'draft',
  'pending_approval',
  'approved',
  'issued',
  'cancelled',
] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

export const invoiceSourceTypes = ['project_stage', 'advance', 'variation'] as const;
export type InvoiceSourceType = (typeof invoiceSourceTypes)[number];

export const scheduleSources = ['quotation', 'variation', 'manual'] as const;
export type ScheduleSource = (typeof scheduleSources)[number];

export const scheduleStatuses = ['planned', 'invoiced', 'cancelled'] as const;
export type ScheduleStatus = (typeof scheduleStatuses)[number];

export const billingAdvanceStatuses = [
  'requested',
  'received',
  'fully_applied',
  'refunded',
] as const;
export type BillingAdvanceStatus = (typeof billingAdvanceStatuses)[number];

export const creditNoteStatuses = ['draft', 'issued'] as const;
export type CreditNoteStatus = (typeof creditNoteStatuses)[number];

export const advanceRecoveryMethods = ['proportional', 'fixed_percent'] as const;
export type AdvanceRecoveryMethod = (typeof advanceRecoveryMethods)[number];

/** Approval document types (H-09 matrix; the owner approves each). */
export const invoiceDocType = 'invoice';
export const creditNoteDocType = 'credit_note';
export const scheduleDocType = 'billing_schedule';

/** Number series (H-04 and H-27); a series per authority is `invoice_<authority>` when one exists. */
export const invoiceSeries = 'invoice';
export const creditNoteSeries = 'credit_note';

/** Settings of the accountant (H-28 and spec BR-3, BR-10). */
export const billingSettingKeys = {
  recoveryMethod: 'billing.advance_recovery_method',
  fixedPercent: 'billing.advance_fixed_percent',
  taxOnAdvanceAtReceipt: 'billing.tax_on_advance_at_receipt',
  defaultPaymentDays: 'billing.default_payment_days',
} as const;
