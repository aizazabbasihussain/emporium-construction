import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money } from '../src/kernel/money.js';
import { calculateSalesTax, type TaxRateRule } from '../src/tax/index.js';

// Spec P2-01 T-3: the document total is exactly base plus tax, and inclusive then exclusive
// round-trips within one paisa. Rates are random test values; the engine ships with none.

const RUNS = { numRuns: 1000 };
const cents = fc
  .integer({ min: 0, max: 500_000_000 })
  .map((n) => Money.of((n / 100).toFixed(2)).toString());
const rate = fc.integer({ min: 0, max: 400_000 }).map((n) => (n / 10000).toFixed(4));
const rule = (ratePercent: string): TaxRateRule => ({
  id: 'r-' + ratePercent,
  authorityCode: 'A',
  taxCode: 'T',
  ratePercent,
});
const modes = fc.constantFrom('per_line' as const, 'per_document' as const);
const includeTax = fc.boolean();

describe('tax calculation properties', () => {
  it('total equals base plus tax exactly, in both modes and both price types', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(cents, rate), { minLength: 0, maxLength: 8 }),
        modes,
        includeTax,
        (rows, roundingMode, pricesIncludeTax) => {
          const lines = rows.map(([amount, r], i) => ({ id: String(i), amount, rule: rule(r) }));
          const result = calculateSalesTax(lines, { roundingMode, pricesIncludeTax });
          expect(Money.of(result.base).add(Money.of(result.taxTotal)).toString()).toBe(
            result.total,
          );
          const groupTax = result.taxLines.reduce(
            (sum, g) => sum.add(Money.of(g.tax)),
            Money.zero(),
          );
          expect(groupTax.toString()).toBe(result.taxTotal);
          if (pricesIncludeTax) {
            const gross = lines.reduce((sum, l) => sum.add(Money.of(l.amount)), Money.zero());
            expect(result.total).toBe(gross.toString());
          }
        },
      ),
      RUNS,
    );
  });

  it('inclusive then exclusive round-trips within one paisa', () => {
    fc.assert(
      fc.property(cents, rate, modes, (net, r, roundingMode) => {
        const exclusive = calculateSalesTax([{ id: '1', amount: net, rule: rule(r) }], {
          roundingMode,
          pricesIncludeTax: false,
        });
        const back = calculateSalesTax([{ id: '1', amount: exclusive.total, rule: rule(r) }], {
          roundingMode,
          pricesIncludeTax: true,
        });
        const drift = Money.of(back.base).sub(Money.of(net));
        expect(drift.value.abs().lte('0.01')).toBe(true);
        expect(back.total).toBe(exclusive.total);
      }),
      RUNS,
    );
  });
});
