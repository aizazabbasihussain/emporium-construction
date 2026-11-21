/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the profitability module. */
export const profitabilityPermissions = {
  // The spec names `profitability.read`; a permission code has three parts (sys_role_permissions).
  read: 'profitability.project.read',
  forecastSet: 'profitability.forecast.set',
  thresholdManage: 'profitability.threshold.manage',
} as const;

export type ProfitabilityPermission =
  (typeof profitabilityPermissions)[keyof typeof profitabilityPermissions];

/** Roles that receive each permission (spec P2-08 section 6). Supervisors have none. */
export const profitabilityPermissionGrants: Record<ProfitabilityPermission, readonly string[]> = {
  'profitability.project.read': ['management', 'accountant', 'project_manager'],
  'profitability.forecast.set': ['project_manager', 'management'],
  'profitability.threshold.manage': ['management'],
};

/** The alert templates (BR-4); the text lives under `notifications.templates`. */
export const profitabilityNotificationTemplates = {
  'profitability.alert.raised': 'notifications.templates.profitabilityAlert',
} as const;

export const thresholdScopes = ['company', 'project'] as const;
export type ThresholdScope = (typeof thresholdScopes)[number];

export const profitabilityAlertCodes = [
  'margin_below_floor',
  'overspend',
  'receivable_overdue',
] as const;
export type ProfitabilityAlertCode = (typeof profitabilityAlertCodes)[number];
