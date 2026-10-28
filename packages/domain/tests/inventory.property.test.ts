import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertReturnable, signedQuantity } from '../src/inventory/index.js';

describe('properties', () => {
  const qty = fc.integer({ min: 1, max: 1_000_000 }).map((n) => (n / 10000).toFixed(4));

  it('a part-return sequence never returns more than was issued', () => {
    fc.assert(
      fc.property(qty, fc.array(qty, { maxLength: 6 }), (issued, returns) => {
        let kept = issued;
        for (const wanted of returns) {
          try {
            kept = assertReturnable(issued, String(Number(issued) - Number(kept)), wanted);
          } catch {
            // refused: the issue is unchanged
          }
        }
        expect(Number(kept)).toBeGreaterThanOrEqual(0);
        expect(Number(kept)).toBeLessThanOrEqual(Number(issued));
      }),
    );
  });

  it('the signed quantities of a movement and its opposite cancel', () => {
    fc.assert(
      fc.property(qty, (q) => {
        expect(Number(signedQuantity('receipt', q)) + Number(signedQuantity('issue', q))).toBe(0);
      }),
    );
  });
});
