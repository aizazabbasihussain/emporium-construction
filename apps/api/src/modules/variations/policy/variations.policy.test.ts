import { variationsPermissions } from '@emporium/shared';
import { describe, expect, it } from 'vitest';
import {
  assertApplied,
  assertCostCodeActive,
  assertFound,
  assertKnown,
  assertProjectActive,
  assertProjectReachable,
  assertUpdated,
  canAccessClientDocument,
} from './variations.policy.js';

describe('variations policy', () => {
  it('reports a missing record as not found', () => {
    expect(assertFound('row', 'variation')).toBe('row');
    expect(() => assertFound(undefined, 'variation')).toThrow(
      expect.objectContaining({ code: 'variation_not_found' }),
    );
  });

  it('reports a moved-on version as a conflict', () => {
    expect(assertUpdated('row')).toBe('row');
    expect(() => assertUpdated(undefined)).toThrow(
      expect.objectContaining({ code: 'version_conflict' }),
    );
    expect(() => assertApplied(true)).not.toThrow();
    expect(() => assertApplied(false)).toThrow(
      expect.objectContaining({ code: 'version_conflict' }),
    );
  });

  it('requires references to exist', () => {
    expect(() => assertKnown(true, 'x', 'x')).not.toThrow();
    expect(() => assertKnown(false, 'unknown_x', 'x')).toThrow(
      expect.objectContaining({ code: 'unknown_x' }),
    );
  });

  it('limits a supervisor to the assigned projects (spec section 6)', () => {
    const supervisor = { roles: ['supervisor'], scopes: [{ type: 'project' as const, id: 'p1' }] };
    expect(() => assertProjectReachable(supervisor, 'p1')).not.toThrow();
    expect(() => assertProjectReachable(supervisor, 'p2')).toThrow(
      expect.objectContaining({ code: 'project_not_found' }),
    );
    expect(() =>
      assertProjectReachable({ roles: ['project_manager'], scopes: [] }, 'p2'),
    ).not.toThrow();
  });

  it('needs an active project (BR-1)', () => {
    expect(() => assertProjectActive('active')).not.toThrow();
    for (const status of ['planning', 'on_hold', 'completed', 'closed', 'cancelled']) {
      expect(() => assertProjectActive(status)).toThrow(
        expect.objectContaining({ code: 'project_not_active' }),
      );
    }
  });

  it('needs an active cost code', () => {
    expect(() => assertCostCodeActive(true)).not.toThrow();
    expect(() => assertCostCodeActive(false)).toThrow(
      expect.objectContaining({ code: 'cost_code_inactive' }),
    );
  });

  describe('client document access (BR-4)', () => {
    const can = (
      permissions: string[],
      operation: 'read' | 'upload' | 'remove',
      variationExists = true,
    ) =>
      canAccessClientDocument({
        permissions: new Set(permissions),
        operation,
        variationExists,
      });

    it('lets readers see it and only approvers change it', () => {
      expect(can([variationsPermissions.read], 'read')).toBe(true);
      expect(can([], 'read')).toBe(false);
      expect(can([variationsPermissions.read], 'upload')).toBe(false);
      expect(can([variationsPermissions.clientApprove], 'upload')).toBe(true);
    });

    it('refuses a variation that does not exist', () => {
      expect(can([variationsPermissions.read], 'read', false)).toBe(false);
    });
  });
});
