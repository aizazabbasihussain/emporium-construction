import { NotFoundError, ValidationError } from '@emporium/domain';
import { isPermissionCode } from '@emporium/domain/identity';
import type { Platform } from '../../platform/index.js';
import {
  findRole,
  insertRoleIfAbsent,
  listRoles,
  replaceRolePermissions,
  selectAllRolePermissions,
  type RoleRow,
} from '../repo/identity.repo.js';
import type { ActionContext, Db, RoleDto } from '../types.js';
import type { PermissionRegistry } from './permission-registry.service.js';

export interface RolesService {
  list(db: Db): Promise<RoleDto[]>;
  /** Replaces the permission set of a role (BR-7). Every code must be registered by a module. */
  setPermissions(
    code: string,
    permissions: readonly string[],
    ctx: ActionContext,
    tx: Db,
  ): Promise<RoleDto>;
  /** Idempotent: an existing role is left untouched. Used by modules that own a role. */
  register(code: string, name: string, description: string, db: Db): Promise<boolean>;
}

export function createRolesService(deps: {
  platform: Platform;
  registry: PermissionRegistry;
}): RolesService {
  const permissionsOf = (role: RoleRow, grants: { role_code: string; permission_code: string }[]) =>
    grants.filter((g) => g.role_code === role.code).map((g) => g.permission_code);

  const dto = (
    role: RoleRow,
    grants: { role_code: string; permission_code: string }[],
  ): RoleDto => ({
    ...role,
    permissions: permissionsOf(role, grants),
  });

  return {
    async list(db) {
      const [roles, grants] = await Promise.all([listRoles(db), selectAllRolePermissions(db)]);
      return roles.map((role) => dto(role, grants));
    },

    async setPermissions(code, permissions, ctx, tx) {
      const role = await findRole(tx, code);
      if (role === undefined) throw new NotFoundError('role_not_found', 'Role not found');
      const wanted = [...new Set(permissions)].sort();
      const unknown = wanted.filter((p) => !isPermissionCode(p) || !deps.registry.has(p));
      if (unknown.length > 0) {
        throw new ValidationError(
          'unknown_permission',
          `Unknown permission: ${unknown.join(', ')}`,
          {
            unknown,
          },
        );
      }
      const before = dto(role, await selectAllRolePermissions(tx));
      await replaceRolePermissions(tx, code, wanted);
      const after = dto(role, await selectAllRolePermissions(tx));
      await deps.platform.audit.record(
        {
          ...ctx,
          action: 'role.permissions_changed',
          entityType: 'role',
          entityId: code,
          before,
          after,
        },
        tx,
      );
      await deps.platform.events.publish(
        { type: 'identity.role.permissions_changed', payload: { roleCode: code } },
        tx,
      );
      return after;
    },

    register: (code, name, description, db) => insertRoleIfAbsent(db, { code, name, description }),
  };
}
