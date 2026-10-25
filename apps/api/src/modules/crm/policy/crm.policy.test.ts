import { crmPermissions } from '@emporium/shared';
import { describe, expect, it } from 'vitest';
import {
  assertApplied,
  assertFollowUpFree,
  assertFound,
  assertKnown,
  assertUpdated,
  canAccessVisitFile,
} from './crm.policy.js';

describe('crm policy', () => {
  it('reports a missing record as not found', () => {
    expect(assertFound('row', 'lead')).toBe('row');
    expect(() => assertFound(undefined, 'lead')).toThrow(
      expect.objectContaining({ code: 'lead_not_found' }),
    );
  });

  it('reports a moved version as a conflict', () => {
    expect(assertUpdated('row')).toBe('row');
    expect(() => assertUpdated(undefined)).toThrow(
      expect.objectContaining({ code: 'version_conflict' }),
    );
    expect(() => assertApplied(true)).not.toThrow();
    expect(() => assertApplied(false)).toThrow(
      expect.objectContaining({ code: 'version_conflict' }),
    );
  });

  it('checks reference codes', () => {
    expect(() => assertKnown(true, 'unknown_x', 'x')).not.toThrow();
    expect(() => assertKnown(false, 'unknown_x', 'x')).toThrow(
      expect.objectContaining({ code: 'unknown_x' }),
    );
  });

  it('allows one open follow-up per assignee and date (BR-4)', () => {
    expect(() => assertFollowUpFree(false)).not.toThrow();
    expect(() => assertFollowUpFree(true)).toThrow(
      expect.objectContaining({ code: 'follow_up_exists' }),
    );
  });

  it('lets readers see site visit photos and visit managers change them (BR-7)', () => {
    const readOnly = new Set([crmPermissions.leadRead]);
    const manager = new Set([crmPermissions.visitManage]);
    const none = new Set<string>();
    const base = { visitExists: true } as const;
    expect(canAccessVisitFile({ ...base, permissions: readOnly, operation: 'read' })).toBe(true);
    expect(canAccessVisitFile({ ...base, permissions: readOnly, operation: 'upload' })).toBe(false);
    expect(canAccessVisitFile({ ...base, permissions: manager, operation: 'upload' })).toBe(true);
    expect(canAccessVisitFile({ ...base, permissions: manager, operation: 'remove' })).toBe(true);
    expect(canAccessVisitFile({ ...base, permissions: manager, operation: 'read' })).toBe(false);
    expect(canAccessVisitFile({ ...base, permissions: none, operation: 'read' })).toBe(false);
  });

  it('refuses files for a visit that does not exist', () => {
    const permissions = new Set([crmPermissions.leadRead, crmPermissions.visitManage]);
    expect(canAccessVisitFile({ permissions, operation: 'read', visitExists: false })).toBe(false);
  });
});
