import { quotationsPermissions } from '@emporium/shared';
import { describe, expect, it } from 'vitest';
import {
  assertApplied,
  assertCompanyProfile,
  assertEstimateLocked,
  assertFound,
  assertKnown,
  assertNoOpenRevision,
  assertNotPastExpiry,
  assertUpdated,
  canAccessAcceptanceFile,
} from './quotations.policy.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('quotations policy', () => {
  it('reports a missing record as not found', () => {
    expect(assertFound(5, 'x')).toBe(5);
    expect(codeOf(() => assertFound(undefined, 'quotation'))).toBe('quotation_not_found');
  });

  it('reports a moved version as a conflict', () => {
    expect(assertUpdated('row')).toBe('row');
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
    expect(() => assertApplied(true)).not.toThrow();
    expect(codeOf(() => assertApplied(false))).toBe('version_conflict');
  });

  it('requires references to exist', () => {
    expect(() => assertKnown(true, 'unknown_party', 'x')).not.toThrow();
    expect(codeOf(() => assertKnown(false, 'unknown_party', 'x'))).toBe('unknown_party');
  });

  it('builds a quotation from a locked estimate only (BR-1)', () => {
    expect(() => assertEstimateLocked('locked')).not.toThrow();
    for (const status of ['draft', 'superseded']) {
      expect(codeOf(() => assertEstimateLocked(status))).toBe('estimate_not_locked');
    }
  });

  it('allows one open revision (BR-4)', () => {
    expect(() => assertNoOpenRevision(false)).not.toThrow();
    expect(codeOf(() => assertNoOpenRevision(true))).toBe('revision_open');
  });

  it('refuses acceptance after the expiry date (BR-5)', () => {
    expect(() => assertNotPastExpiry(false)).not.toThrow();
    expect(codeOf(() => assertNotPastExpiry(true))).toBe('quotation_expired');
  });

  it('needs the company profile to print (BR-8)', () => {
    expect(assertCompanyProfile({ name: 'x' })).toEqual({ name: 'x' });
    expect(codeOf(() => assertCompanyProfile(null))).toBe('company_profile_missing');
  });
});

describe('acceptance document access (BR-6)', () => {
  const access = (permissions: string[], operation: 'read' | 'upload' | 'remove', exists = true) =>
    canAccessAcceptanceFile({
      permissions: new Set(permissions),
      operation,
      quotationExists: exists,
    });

  it('lets readers read and acceptors add or remove', () => {
    expect(access([quotationsPermissions.read], 'read')).toBe(true);
    expect(access([quotationsPermissions.read], 'upload')).toBe(false);
    expect(access([quotationsPermissions.accept], 'upload')).toBe(true);
    expect(access([quotationsPermissions.accept], 'remove')).toBe(true);
    expect(access([quotationsPermissions.accept], 'read')).toBe(false);
    expect(access([], 'read')).toBe(false);
  });

  it('refuses when the quotation does not exist', () => {
    expect(access([quotationsPermissions.read, quotationsPermissions.accept], 'read', false)).toBe(
      false,
    );
  });
});
