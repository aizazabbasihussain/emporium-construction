import { NotFoundError, RuleViolationError, ValidationError } from '@emporium/domain';
import { describe, expect, it } from 'vitest';
import {
  assertDifferentStores,
  assertFound,
  assertIssue,
  assertItemKnown,
  deciderOf,
} from './valuation.policy.js';

describe('valuation policy guards', () => {
  it('reports a missing record as not found', () => {
    expect(assertFound({ id: 1 }, 'policy')).toEqual({ id: 1 });
    expect(() => assertFound(undefined, 'policy')).toThrow(NotFoundError);
  });

  it('requires a known item', () => {
    expect(assertItemKnown({ id: 'i' })).toEqual({ id: 'i' });
    expect(() => assertItemKnown(undefined)).toThrow(ValidationError);
  });

  it('lets only an issue be returned (BR-9)', () => {
    expect(() => assertIssue({ type: 'issue' })).not.toThrow();
    for (const type of ['receipt', 'transfer_out', 'transfer_in', 'return', 'transition']) {
      expect(() => assertIssue({ type })).toThrow(RuleViolationError);
    }
  });

  it('needs two different stores for a transfer (BR-8)', () => {
    expect(() => assertDifferentStores('a', 'b')).not.toThrow();
    expect(() => assertDifferentStores('a', 'a')).toThrow(/different stores/);
  });

  it('names the last person to act on an approval', () => {
    expect(deciderOf({ status: 'none' })).toBeNull();
    expect(deciderOf({ status: 'pending', actions: [] })).toBeNull();
    expect(deciderOf({ status: 'approved', actions: [{ actorId: 'a' }, { actorId: 'b' }] })).toBe(
      'b',
    );
  });
});
