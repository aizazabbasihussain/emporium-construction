/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the identity module. */
export const identityPermissions = {
  userManage: 'identity.user.manage',
  roleManage: 'identity.role.manage',
  userRead: 'identity.user.read',
} as const;

export type IdentityPermission = (typeof identityPermissions)[keyof typeof identityPermissions];

/** Roles that receive each identity permission (spec P1-02 section 6). */
export const identityPermissionGrants: Record<IdentityPermission, readonly string[]> = {
  'identity.user.manage': ['admin'],
  'identity.role.manage': ['admin'],
  'identity.user.read': ['admin', 'management'],
};

export const seededRoles = [
  'admin',
  'management',
  'project_manager',
  'procurement',
  'storekeeper',
  'supervisor',
  'accountant',
  'service_coordinator',
  'estimator',
] as const;

export const scopeTypes = ['project', 'team'] as const;
export type ScopeType = (typeof scopeTypes)[number];

export const locales = ['en', 'ur'] as const;
export type Locale = (typeof locales)[number];

export const userStatuses = ['active', 'disabled'] as const;
export type UserStatus = (typeof userStatuses)[number];

/** Languages written right to left. */
export const isRtl = (locale: string): boolean => locale === 'ur';
