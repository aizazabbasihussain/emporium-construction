export interface RoleGrant {
  code: string;
  permissions: readonly string[];
}

/** BR-3: a user holds the union of the permissions of all assigned roles. */
export function unionPermissions(roles: readonly RoleGrant[]): Set<string> {
  const union = new Set<string>();
  for (const role of roles) for (const permission of role.permissions) union.add(permission);
  return union;
}

const CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$/;

/** Permission codes are `<module>.<resource>.<action>` (constitution 7.2). */
export const isPermissionCode = (code: string): boolean => CODE.test(code);

/** True when `code` is well formed and belongs to `module`. */
export const permissionBelongsTo = (code: string, module: string): boolean =>
  isPermissionCode(code) && code.startsWith(`${module}.`);
