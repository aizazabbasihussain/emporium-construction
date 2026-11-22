/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by accounting-exports. */
export const accountingPermissions = {
  exportRun: 'accounting.export.run',
  exportRead: 'accounting.export.read',
  tagManage: 'accounting.tag.manage',
  rulesManage: 'accounting.rules.manage',
} as const;

export type AccountingPermission =
  (typeof accountingPermissions)[keyof typeof accountingPermissions];

/** Roles that receive each permission (spec P2-09 section 6). */
export const accountingPermissionGrants: Record<AccountingPermission, readonly string[]> = {
  'accounting.export.run': ['accountant', 'management'],
  'accounting.export.read': ['accountant', 'management'],
  'accounting.tag.manage': ['accountant'],
  'accounting.rules.manage': ['accountant'],
};

/** Financial documents whose lines can carry an account tag (BR-1). */
export const accountingDocTypes = [
  'invoice',
  'credit_note',
  'bill',
  'vendor_payment',
  'receipt',
  'cash_transaction',
  'payroll_run',
  'stock_movement',
  'expense_claim',
] as const;
export type AccountingDocType = (typeof accountingDocTypes)[number];

export const accountTypes = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof accountTypes)[number];

export const tagMethods = ['rule', 'manual'] as const;
export type TagMethod = (typeof tagMethods)[number];

/** The exports of BR-3; each has a fixed layout in `docs/exports/<code>.md`. */
export const exportCodes = [
  'sales_register',
  'purchase_register',
  'receipts_register',
  'payments_register',
  'cash_bank_book',
  'pdc_register',
  'customer_ledger',
  'vendor_ledger',
  'aging',
  'withholding_report',
  'payroll_summary',
  'stock_valuation',
  'project_cost_profit',
  'subcontractor_statements',
] as const;
export type ExportCode = (typeof exportCodes)[number];
