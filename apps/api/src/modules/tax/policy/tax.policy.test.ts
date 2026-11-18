import { Percent } from '@emporium/domain/kernel';
import { describe, expect, it } from 'vitest';
import {
  assertAuthorityKnown,
  assertFound,
  assertMonth,
  assertRateInRange,
  assertRegistered,
  deciderOf,
} from './tax.policy.js';

describe('tax policy guards', () => {
  it('reports a missing record as not found', () => {
    expect(assertFound('x', 'rule')).toBe('x');
    expect(() => assertFound(undefined, 'rule')).toThrow('Not found');
  });

  it('accepts only known authorities', () => {
    expect(() => assertAuthorityKnown(['FBR'], 'FBR')).not.toThrow();
    expect(() => assertAuthorityKnown(['FBR'], 'PRA')).toThrow('Unknown tax authority PRA');
  });

  it('keeps a rate between 0 and 100 percent, both ends included', () => {
    expect(() => assertRateInRange(Percent.of('0'))).not.toThrow();
    expect(() => assertRateInRange(Percent.of('100'))).not.toThrow();
    expect(() => assertRateInRange(Percent.of('100.0001'))).toThrow('between 0 and 100');
    expect(() => assertRateInRange(Percent.of('-0.0001'))).toThrow('between 0 and 100');
  });

  it('requires a registration', () => {
    expect(assertRegistered({ number: '1' }, 'FBR', '2026-01-01')).toEqual({ number: '1' });
    expect(() => assertRegistered(null, 'FBR', '2026-01-01')).toThrow('no FBR registration');
  });

  it('checks the month format', () => {
    expect(() => assertMonth('2026-12')).not.toThrow();
    for (const bad of ['2026-00', '2026-13', '2026-1', '26-10', '2026-10-01']) {
      expect(() => assertMonth(bad), bad).toThrow('2026-10');
    }
  });

  it('names the last person to act on an approval', () => {
    expect(deciderOf({ status: 'approved', actions: [{ actorId: 'a' }, { actorId: 'b' }] })).toBe(
      'b',
    );
    expect(deciderOf({ status: 'approved', actions: [] })).toBeNull();
    expect(deciderOf({ status: 'none' })).toBeNull();
  });
});
