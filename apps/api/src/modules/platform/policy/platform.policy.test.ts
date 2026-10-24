import { platformPermissions } from '@emporium/shared';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../types.js';
import { canOverrideBackdating, requirePermission } from './platform.policy.js';

const user = (...permissions: string[]): Principal => ({
  userId: 'u1',
  permissions: new Set(permissions),
});

describe('platform policy', () => {
  it('returns the caller when the permission is held', () => {
    const principal = user(platformPermissions.auditRead);
    expect(requirePermission(principal, platformPermissions.auditRead)).toBe(principal);
  });

  it('rejects anonymous callers with 401 semantics', () => {
    expect(() => requirePermission(undefined, platformPermissions.auditRead)).toThrow(
      expect.objectContaining({ kind: 'unauthorized' }),
    );
    expect(() => requirePermission(null, platformPermissions.auditRead)).toThrow(
      expect.objectContaining({ kind: 'unauthorized' }),
    );
  });

  it.each(Object.values(platformPermissions))('rejects a caller without %s', (permission) => {
    expect(() => requirePermission(user(), permission)).toThrow(
      expect.objectContaining({ kind: 'forbidden' }),
    );
  });

  it('knows who may override backdating', () => {
    expect(canOverrideBackdating(user(platformPermissions.backdateOverride))).toBe(true);
    expect(canOverrideBackdating(user(platformPermissions.auditRead))).toBe(false);
  });
});
