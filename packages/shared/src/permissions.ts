/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the platform kernel. */
export const platformPermissions = {
  auditRead: 'platform.audit.read',
  settingsManage: 'platform.settings.manage',
  seriesManage: 'platform.series.manage',
  outboxManage: 'platform.outbox.manage',
  backdateOverride: 'platform.backdate.override',
} as const;

export type PlatformPermission = (typeof platformPermissions)[keyof typeof platformPermissions];

/** Roles that receive each permission when P1-02 seeds roles (spec P1-01 section 6). */
export const platformPermissionGrants: Record<PlatformPermission, readonly string[]> = {
  'platform.audit.read': ['admin', 'accountant'],
  'platform.settings.manage': ['admin'],
  'platform.series.manage': ['admin', 'accountant'],
  'platform.outbox.manage': ['admin'],
  'platform.backdate.override': ['admin'],
};
