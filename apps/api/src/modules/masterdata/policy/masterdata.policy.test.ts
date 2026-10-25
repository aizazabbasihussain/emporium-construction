import { describe, expect, it } from 'vitest';
import {
  assertApplied,
  assertCostCodeMayDeactivate,
  assertFound,
  assertNoDuplicates,
  assertNotReferenced,
  assertUnused,
  assertUpdated,
} from './masterdata.policy.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('masterdata policy', () => {
  it('reports a missing record as not found', () => {
    expect(assertFound({ id: 1 }, 'party')).toEqual({ id: 1 });
    expect(codeOf(() => assertFound(undefined, 'party'))).toBe('party_not_found');
  });

  it('reports a moved-on version as a conflict', () => {
    expect(assertUpdated({ version: 2 })).toEqual({ version: 2 });
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
    expect(() => assertApplied(true)).not.toThrow();
    expect(codeOf(() => assertApplied(false))).toBe('version_conflict');
  });

  it('refuses to delete referenced records and records in use (T-7, BR-8)', () => {
    expect(() => assertNotReferenced(false, 'party')).not.toThrow();
    expect(codeOf(() => assertNotReferenced(true, 'party'))).toBe('party_referenced');
    expect(() => assertUnused(false, 'x_in_use', 'm')).not.toThrow();
    expect(codeOf(() => assertUnused(true, 'x_in_use', 'm'))).toBe('x_in_use');
  });

  it('blocks NTN and CNIC repeats and only warns about name plus phone (T-1, BR-2)', () => {
    expect(() => assertNoDuplicates([], false)).not.toThrow();
    const soft = [{ id: 'a', reason: 'name_phone' as const }];
    expect(codeOf(() => assertNoDuplicates(soft, false))).toBe('duplicate_warning');
    expect(() => assertNoDuplicates(soft, true)).not.toThrow();
    const hard = [...soft, { id: 'b', reason: 'ntn' as const }];
    expect(codeOf(() => assertNoDuplicates(hard, true))).toBe('duplicate_party');
  });

  it('keeps a code with posted costs and open budget lines active (T-5, BR-6)', () => {
    expect(() =>
      assertCostCodeMayDeactivate({ postedCosts: true, openBudgetLines: false }),
    ).not.toThrow();
    expect(
      codeOf(() => assertCostCodeMayDeactivate({ postedCosts: true, openBudgetLines: true })),
    ).toBe('cost_code_in_use');
  });
});
