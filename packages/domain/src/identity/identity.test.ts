import { describe, expect, it } from 'vitest';
import { RuleViolationError } from '../errors.js';
import {
  assertRoleChangeAllowed,
  assertStatusChangeAllowed,
  hasScope,
  isPermissionCode,
  isScopeLimited,
  permissionBelongsTo,
  scopeFilter,
  unionPermissions,
} from './index.js';

const violation = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RuleViolationError);
    return (error as RuleViolationError).code;
  }
  return undefined;
};

describe('permission union (BR-3)', () => {
  it('unions the permissions of all roles and handles no roles', () => {
    const union = unionPermissions([
      { code: 'a', permissions: ['m.r.read', 'm.r.write'] },
      { code: 'b', permissions: ['m.r.read', 'n.x.y'] },
    ]);
    expect([...union].sort()).toEqual(['m.r.read', 'm.r.write', 'n.x.y']);
    expect(unionPermissions([]).size).toBe(0);
  });

  it('recognises well-formed permission codes and their module', () => {
    expect(isPermissionCode('identity.user.manage')).toBe(true);
    expect(isPermissionCode('identity.user')).toBe(false);
    expect(isPermissionCode('Identity.user.manage')).toBe(false);
    expect(permissionBelongsTo('identity.user.manage', 'identity')).toBe(true);
    expect(permissionBelongsTo('identity.user.manage', 'platform')).toBe(false);
    expect(permissionBelongsTo('identity', 'identity')).toBe(false);
  });
});

describe('role change lockout (BR-5)', () => {
  const base = {
    actorId: 'a',
    targetId: 'b',
    targetStatus: 'active' as const,
    currentRoles: ['admin', 'accountant'],
    newRoles: ['accountant'],
    activeAdminCount: 2,
  };

  it('allows demoting another admin when another active admin remains', () => {
    expect(violation(() => assertRoleChangeAllowed(base))).toBeUndefined();
  });

  it('refuses removing your own admin role', () => {
    expect(violation(() => assertRoleChangeAllowed({ ...base, targetId: 'a' }))).toBe(
      'cannot_remove_own_admin',
    );
  });

  it('refuses demoting the last active admin', () => {
    expect(violation(() => assertRoleChangeAllowed({ ...base, activeAdminCount: 1 }))).toBe(
      'last_admin',
    );
  });

  it('allows demoting a disabled admin and any change that keeps or adds admin', () => {
    expect(
      violation(() =>
        assertRoleChangeAllowed({ ...base, targetStatus: 'disabled', activeAdminCount: 1 }),
      ),
    ).toBeUndefined();
    expect(
      violation(() => assertRoleChangeAllowed({ ...base, newRoles: ['admin'], targetId: 'a' })),
    ).toBeUndefined();
    expect(
      violation(() =>
        assertRoleChangeAllowed({
          ...base,
          currentRoles: ['accountant'],
          newRoles: ['accountant', 'admin'],
        }),
      ),
    ).toBeUndefined();
  });
});

describe('status change lockout (BR-5)', () => {
  const base = {
    actorId: 'a',
    targetId: 'b',
    from: 'active' as const,
    to: 'disabled' as const,
    targetRoles: ['admin'],
    activeAdminCount: 2,
  };

  it('refuses disabling yourself and the last active admin', () => {
    expect(violation(() => assertStatusChangeAllowed({ ...base, targetId: 'a' }))).toBe(
      'cannot_disable_self',
    );
    expect(violation(() => assertStatusChangeAllowed({ ...base, activeAdminCount: 1 }))).toBe(
      'last_admin',
    );
  });

  it('allows disabling another admin, non-admins, and any other transition', () => {
    expect(violation(() => assertStatusChangeAllowed(base))).toBeUndefined();
    expect(
      violation(() =>
        assertStatusChangeAllowed({ ...base, targetRoles: ['storekeeper'], activeAdminCount: 1 }),
      ),
    ).toBeUndefined();
    expect(
      violation(() => assertStatusChangeAllowed({ ...base, from: 'disabled', to: 'active' })),
    ).toBeUndefined();
    expect(
      violation(() => assertStatusChangeAllowed({ ...base, from: 'active', to: 'active' })),
    ).toBeUndefined();
  });
});

describe('scope rules (BR-4)', () => {
  const supervisor = {
    roles: ['supervisor'],
    scopes: [
      { type: 'project' as const, id: 'p1' },
      { type: 'team' as const, id: 't1' },
    ],
  };

  it('limits users whose roles are all scoped', () => {
    expect(isScopeLimited(supervisor)).toBe(true);
    expect(isScopeLimited({ roles: ['supervisor', 'project_manager'] })).toBe(false);
    expect(isScopeLimited({ roles: [] })).toBe(false);
  });

  it('lets a supervisor reach only assigned scopes of the right type', () => {
    expect(hasScope(supervisor, 'project', 'p1')).toBe(true);
    expect(hasScope(supervisor, 'project', 'p2')).toBe(false);
    expect(hasScope(supervisor, 'project', 't1')).toBe(false);
    expect(hasScope(supervisor, 'team', 't1')).toBe(true);
  });

  it('lets unscoped users reach everything', () => {
    const manager = { roles: ['management'], scopes: [] };
    expect(hasScope(manager, 'project', 'anything')).toBe(true);
    expect(scopeFilter(manager, 'project')).toEqual({ all: true });
  });

  it('produces the id filter for a scoped user, empty when nothing is assigned', () => {
    expect(scopeFilter(supervisor, 'project')).toEqual({ all: false, ids: ['p1'] });
    expect(scopeFilter({ roles: ['supervisor'], scopes: [] }, 'team')).toEqual({
      all: false,
      ids: [],
    });
  });
});
