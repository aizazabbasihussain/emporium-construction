import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { spreadDifference, sumMoney } from '../src/payroll/index.js';

const SEED = 20261121;

describe('payroll properties (T-1)', () => {
  it('the spread amounts add up exactly to the difference, whatever the shares', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100_000_000, max: 100_000_000 }),
        fc.array(fc.integer({ min: 0, max: 5_000_000 }), { minLength: 1, maxLength: 12 }),
        (cents, weights) => {
          fc.pre(weights.some((w) => w > 0));
          const difference = (cents / 100).toFixed(2);
          const parts = spreadDifference(
            difference,
            weights.map((weight, index) => ({ key: String(index), weight: String(weight) })),
          );
          expect(sumMoney(parts.map((p) => p.amount))).toBe(difference.replace('-0.00', '0.00'));
          // Every part is within one paisa of its exact share and never of the wrong sign.
          const total = weights.reduce((a, b) => a + b, 0);
          parts.forEach((part, index) => {
            const exact = (cents * (weights[index] as number)) / total / 100;
            expect(Math.abs(Number(part.amount) - exact)).toBeLessThan(0.0100001);
            if (cents >= 0) expect(Number(part.amount)).toBeGreaterThanOrEqual(0);
            else expect(Number(part.amount)).toBeLessThanOrEqual(0);
          });
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });
});
