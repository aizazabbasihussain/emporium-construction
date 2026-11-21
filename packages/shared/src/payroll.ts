/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the payroll module. */
export const payrollPermissions = {
  runRead: 'payroll.run.read',
  runCreate: 'payroll.run.create',
  runFinalize: 'payroll.run.finalize',
  /** Marking lines paid and recording the cash book payment (the accountant). */
  paymentCreate: 'payroll.payment.create',
  /** Reversing a recorded payment (management). */
  paymentReverse: 'payroll.payment.reverse',
  /** Reopening an unpaid finalized run (management). */
  runReopen: 'payroll.run.reopen',
  payslipRead: 'payroll.payslip.read',
} as const;

export type PayrollPermission = (typeof payrollPermissions)[keyof typeof payrollPermissions];

/** Spec P2-07 section 6: the accountant runs payroll, management reads, reverses and reopens. */
export const payrollPermissionGrants: Record<PayrollPermission, readonly string[]> = {
  'payroll.run.read': ['admin', 'accountant', 'management'],
  'payroll.run.create': ['admin', 'accountant'],
  'payroll.run.finalize': ['admin', 'accountant'],
  'payroll.payment.create': ['admin', 'accountant'],
  'payroll.payment.reverse': ['admin', 'management'],
  'payroll.run.reopen': ['admin', 'management'],
  'payroll.payslip.read': ['admin', 'accountant', 'management'],
};

export const payrollRunStatuses = ['draft', 'finalized', 'part_paid', 'paid'] as const;
export type PayrollRunStatus = (typeof payrollRunStatuses)[number];

export const payrollPaymentMethods = ['cash', 'bank_transfer', 'wallet'] as const;
export type PayrollPaymentMethod = (typeof payrollPaymentMethods)[number];

export const payrollLineStatuses = ['unpaid', 'paid'] as const;
export type PayrollLineStatus = (typeof payrollLineStatuses)[number];

export const costDifferenceTreatments = ['spread_to_projects', 'overhead'] as const;
export type CostDifferenceTreatment = (typeof costDifferenceTreatments)[number];

/** The number series of payslips (BR-3). */
export const payslipSeries = 'payslip';

/** The cost ledger source type of the difference between attendance cost and payroll (BR-2). */
export const payrollAdjustmentDocType = 'payroll_adjustment';

/** Settings of the accountant (BR-4). */
export const payrollSettingKeys = {
  /** One cash book transaction per paid line instead of one per method and account. */
  cashTxnPerLine: 'payroll_cash_txn_per_line',
} as const;
