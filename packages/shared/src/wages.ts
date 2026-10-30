/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the wages module. */
export const wagesPermissions = {
  periodRead: 'wages.period.read',
  periodCalculate: 'wages.period.calculate',
  periodSubmit: 'wages.period.submit',
  periodReopen: 'wages.period.reopen',
  adjustmentManage: 'wages.adjustment.manage',
  advanceManage: 'wages.advance.manage',
} as const;

export type WagesPermission = (typeof wagesPermissions)[keyof typeof wagesPermissions];

/** Roles that receive each permission (spec P1-18 section 6). Supervisors have none. */
export const wagesPermissionGrants: Record<WagesPermission, readonly string[]> = {
  'wages.period.read': ['accountant', 'management'],
  'wages.period.calculate': ['accountant', 'management'],
  'wages.period.submit': ['accountant', 'management'],
  'wages.period.reopen': ['management'],
  'wages.adjustment.manage': ['accountant'],
  'wages.advance.manage': ['accountant'],
};

export const periodStatuses = ['draft', 'calculated', 'submitted', 'approved', 'reopened'] as const;
export type PeriodStatus = (typeof periodStatuses)[number];

export const adjustmentKinds = ['allowance', 'deduction'] as const;
export type AdjustmentKind = (typeof adjustmentKinds)[number];

export const wageAdvanceStatuses = ['open', 'closed'] as const;
export type WageAdvanceStatus = (typeof wageAdvanceStatuses)[number];

/** The approval document type of a submitted wage period. */
export const wagePeriodDocType = 'wage_period';

/** Settings of this module (H-11 and BR-2, BR-7); the basis and multiplier are owned by earlier modules. */
export const wagesSettingKeys = {
  payOffDaysDaily: 'wages.pay_off_days_daily',
  roundNetToRupee: 'wages.round_net_to_rupee',
  workingDaysBasis: 'workforce.working_days_basis',
  overtimeMultiplier: 'attendance.overtime_multiplier',
} as const;
