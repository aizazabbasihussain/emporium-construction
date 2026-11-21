import { describe, expect, it } from 'vitest';
import { assertUpdated, assertFound, assertPositive } from './payables.policy.js';

describe('payables policy helpers', () => {
  it('reports a missed optimistic update as a version conflict', () => {
    expect(() => assertUpdated(undefined)).toThrowError(
      expect.objectContaining({ code: 'version_conflict' }) as Error,
    );
    expect(assertUpdated({ id: 1 })).toEqual({ id: 1 });
  });

  it('reports a missing record as not found', () => {
    expect(() => assertFound(undefined, 'bill')).toThrowError(
      expect.objectContaining({ code: 'bill_not_found' }) as Error,
    );
    expect(assertFound('x', 'bill')).toBe('x');
  });

  it('wants an amount above zero', () => {
    expect(() => assertPositive('0', 'amount')).toThrowError(
      expect.objectContaining({ code: 'amount_invalid' }) as Error,
    );
    expect(() => assertPositive('-1', 'amount')).toThrowError(
      expect.objectContaining({ code: 'amount_invalid' }) as Error,
    );
    expect(() => assertPositive('0.01', 'amount')).not.toThrow();
  });
});
