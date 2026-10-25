import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { convertQuantity } from '../src/masterdata/rules.js';

// Property tests live outside src/ because the domain-stays-pure rule keeps test libraries out of it.
describe('unit conversion (property test, T-4)', () => {
  it('property: converting from the larger unit and back stays within 1 unit of the 4th decimal', () => {
    const quantity = fc
      .integer({ min: 0, max: 1_000_000_000 })
      .map((tenThousandths) => new Decimal(tenThousandths).div(10_000).toFixed(4));
    // 1 `big` = factor `small`, factor >= 1: the stored pair is big -> small.
    const factor = fc
      .integer({ min: 1_000_000, max: 1_000_000_000 })
      .map((millionths) => new Decimal(millionths).div(1_000_000).toFixed(6));
    fc.assert(
      fc.property(quantity, factor, (x, f) => {
        const pairs = [{ fromUnit: 'big', toUnit: 'small', factor: f }];
        const there = convertQuantity(x, 'big', 'small', pairs);
        const back = convertQuantity(there, 'small', 'big', pairs);
        expect(new Decimal(back).sub(x).abs().lte('0.0001')).toBe(true);
      }),
    );
  });

  it('property: the result always has exactly 4 decimals', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (n) => {
        const x = new Decimal(n).div(1000).toString();
        const pairs = [{ fromUnit: 'a', toUnit: 'b', factor: '2.5' }];
        expect(convertQuantity(x, 'a', 'b', pairs)).toMatch(/^\d+\.\d{4}$/);
        expect(convertQuantity(x, 'b', 'a', pairs)).toMatch(/^\d+\.\d{4}$/);
      }),
    );
  });
});
