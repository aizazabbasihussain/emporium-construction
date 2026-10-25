import { describe, expect, it } from 'vitest';
import {
  assertApplied,
  assertCodeFree,
  assertFound,
  assertKnown,
  assertLockedForBudget,
  assertRevisable,
  assertTemplateActive,
  assertUpdated,
} from './estimation.policy.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('estimation policy', () => {
  it('reports a missing record as not found', () => {
    expect(assertFound(5, 'x')).toBe(5);
    expect(codeOf(() => assertFound(undefined, 'estimate'))).toBe('estimate_not_found');
  });

  it('reports a moved version as a conflict', () => {
    expect(assertUpdated('row')).toBe('row');
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
    expect(codeOf(() => assertApplied(true))).toBeUndefined();
    expect(codeOf(() => assertApplied(false))).toBe('version_conflict');
  });

  it('checks references, codes and template state', () => {
    expect(codeOf(() => assertKnown(true, 'unknown_unit', 'm'))).toBeUndefined();
    expect(codeOf(() => assertKnown(false, 'unknown_unit', 'm'))).toBe('unknown_unit');
    expect(codeOf(() => assertCodeFree(false))).toBeUndefined();
    expect(codeOf(() => assertCodeFree(true))).toBe('code_taken');
    expect(codeOf(() => assertTemplateActive(true))).toBeUndefined();
    expect(codeOf(() => assertTemplateActive(false))).toBe('template_inactive');
  });

  it('allows a revision only of a locked estimate without an open revision (BR-8)', () => {
    expect(codeOf(() => assertRevisable('locked', false))).toBeUndefined();
    expect(codeOf(() => assertRevisable('locked', true))).toBe('revision_open');
    expect(codeOf(() => assertRevisable('draft', false))).toBe('estimate_not_locked');
    expect(codeOf(() => assertRevisable('superseded', false))).toBe('estimate_not_locked');
  });

  it('reads the budget from a locked estimate only', () => {
    expect(codeOf(() => assertLockedForBudget('locked'))).toBeUndefined();
    expect(codeOf(() => assertLockedForBudget('draft'))).toBe('estimate_not_locked');
    expect(codeOf(() => assertLockedForBudget('superseded'))).toBe('estimate_not_locked');
  });
});
