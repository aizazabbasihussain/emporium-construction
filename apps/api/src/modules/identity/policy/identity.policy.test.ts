import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../types.js';
import {
  assertAdmin,
  assertPermission,
  assertScopeForRead,
  scopeFilterFor,
  userHasScope,
} from './identity.policy.js';

const user = (roles: string[], permissions: string[] = [], scopes: CurrentUser['scopes'] = []) =>
  ({
    userId: 'u1',
    email: 'u@example.test',
    fullName: 'U',
    locale: 'en',
    version: 1,
    roles,
    permissions: new Set(permissions),
    scopes,
  }) satisfies CurrentUser;

describe('identity policy', () => {
  it('returns the caller when the permission is held', () => {
    const caller = user(['accountant'], ['a.b.c']);
    expect(assertPermission(caller, 'a.b.c')).toBe(caller);
  });

  it('answers 401 without a caller', () => {
    expect(() => assertPermission(undefined, 'a.b.c')).toThrow(
      expect.objectContaining({ kind: 'unauthorized' }),
    );
    expect(() => assertPermission(null, 'a.b.c')).toThrow(
      expect.objectContaining({ kind: 'unauthorized' }),
    );
  });

  it('answers 403 naming the missing permission (BR-3)', () => {
    expect(() => assertPermission(user([], ['x.y.z']), 'a.b.c')).toThrow(
      expect.objectContaining({
        kind: 'forbidden',
        code: 'permission_denied',
        details: { permission: 'a.b.c' },
      }),
    );
  });

  it('limits administration to the admin role (BR-5)', () => {
    const admin = user(['admin']);
    expect(assertAdmin(admin)).toBe(admin);
    expect(() => assertAdmin(user(['management']))).toThrow(
      expect.objectContaining({ kind: 'forbidden', code: 'admin_only' }),
    );
  });

  describe('scope matrix (T-3)', () => {
    const supervisor = user(
      ['supervisor'],
      [],
      [
        { type: 'project', id: 'p1' },
        { type: 'team', id: 't1' },
      ],
    );
    const manager = user(['management']);
    const both = user(['supervisor', 'project_manager']);

    it('lets a supervisor read only the assigned project and answers 404 for others', () => {
      expect(userHasScope(supervisor, 'project', 'p1')).toBe(true);
      expect(() => assertScopeForRead(supervisor, 'project', 'p1')).not.toThrow();
      expect(userHasScope(supervisor, 'project', 'p2')).toBe(false);
      expect(() => assertScopeForRead(supervisor, 'project', 'p2')).toThrow(
        expect.objectContaining({ kind: 'not_found' }),
      );
      expect(() => assertScopeForRead(supervisor, 'team', 'p1')).toThrow(
        expect.objectContaining({ kind: 'not_found' }),
      );
    });

    it('lets managers and mixed-role users see everything', () => {
      expect(userHasScope(manager, 'project', 'p9')).toBe(true);
      expect(userHasScope(both, 'team', 't9')).toBe(true);
      expect(scopeFilterFor(manager, 'project')).toEqual({ all: true });
    });

    it('builds the list filter for a supervisor', () => {
      expect(scopeFilterFor(supervisor, 'project')).toEqual({ all: false, ids: ['p1'] });
      expect(scopeFilterFor(supervisor, 'team')).toEqual({ all: false, ids: ['t1'] });
    });
  });
});
