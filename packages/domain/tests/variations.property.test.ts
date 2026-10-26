import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { currentContractValue, impactTotals, normalizeLines } from '../src/variations/index.js';

const cents = fc.integer({ min: -9_000_000_000, max: 9_000_000_000 });
const money = (value: number) => (value / 100).toFixed(2);

describe('variation money invariants', () => {
  it('the price impact is the sum of the line prices, in any order', () => {
    fc.assert(
      fc.property(fc.array(cents, { minLength: 1, maxLength: 12 }), (prices) => {
        const lines = normalizeLines(
          prices.map((price) => ({
            description: 'line',
            costCodeId: 'c',
            costAmount: '1.00',
            priceAmount: money(price),
          })),
        );
        const expected = prices.reduce((sum, price) => sum + price, 0);
        expect(impactTotals(lines).priceImpact).toBe(money(expected));
        expect(impactTotals([...lines].reverse()).priceImpact).toBe(money(expected));
      }),
    );
  });

  it('the current contract value moves by exactly the approved impacts and never touches the original', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9_000_000_000 }),
        fc.array(cents, { maxLength: 10 }),
        (original, impacts) => {
          const value = currentContractValue(money(original), impacts.map(money));
          const expected = impacts.reduce((sum, impact) => sum + impact, original);
          expect(value).toBe(money(expected));
        },
      ),
    );
  });
});
