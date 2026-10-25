import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/errors.js';
import { deriveStages, type StageInput } from '../src/quotations/stages.js';

const price = fc
  .tuple(fc.integer({ min: 1, max: 999_999_999 }), fc.integer({ min: 0, max: 99 }))
  .map(([whole, paisa]) => `${whole}.${String(paisa).padStart(2, '0')}`);

/** Splits 100.0000 into 1 to 8 positive four-decimal parts. */
const percentSplit = fc
  .uniqueArray(fc.integer({ min: 1, max: 999_999 }), { minLength: 0, maxLength: 7 })
  .map((cuts) => {
    const points = [0, ...[...cuts].sort((a, b) => a - b), 1_000_000];
    return points.slice(1).map((point, i) => (point - (points[i] as number)) / 10_000);
  })
  .map((parts) => parts.map((p) => new Decimal(p).toFixed(4)));

describe('stage schedule invariants (spec P1-08 T-1)', () => {
  it('stage percents add up to 100 and stage amounts to the price exactly', () => {
    fc.assert(
      fc.property(price, percentSplit, (total, split) => {
        const input: StageInput[] = split.map((percent, i) => ({
          name: `S${i}`,
          basis: 'percent',
          percent,
        }));
        let stages;
        try {
          stages = deriveStages(total, input);
        } catch (error) {
          // The only legitimate refusal is a split that rounds below zero in the last stage.
          expect((error as ValidationError).code).toBe('stage_amount_negative');
          return;
        }
        const sumPercent = stages.reduce((s, x) => s.plus(x.percent), new Decimal(0));
        const sumAmount = stages.reduce((s, x) => s.plus(x.amount), new Decimal(0));
        expect(sumPercent.toFixed(4)).toBe('100.0000');
        expect(sumAmount.toFixed(2)).toBe(total);
        for (const stage of stages)
          expect(new Decimal(stage.amount).decimalPlaces()).toBeLessThanOrEqual(2);
      }),
      { numRuns: 1000 },
    );
  });

  it('refuses percents whose sum differs from 100', () => {
    fc.assert(
      fc.property(price, fc.integer({ min: 1, max: 999_999 }), (total, off) => {
        const wrong = new Decimal(100).plus(new Decimal(off).div(10_000)).toFixed(4);
        expect(() =>
          deriveStages(total, [
            { name: 'A', basis: 'percent', percent: '50.0000' },
            { name: 'B', basis: 'percent', percent: new Decimal(wrong).minus(50).toFixed(4) },
          ]),
        ).toThrow(ValidationError);
      }),
      { numRuns: 200 },
    );
  });

  it('amount-basis schedules that add up to the price are accepted, others refused', () => {
    fc.assert(
      fc.property(price, fc.integer({ min: 1, max: 99 }), (total, cut) => {
        const t = new Decimal(total);
        fc.pre(t.greaterThan(1));
        const first = t.times(cut).div(100).toDecimalPlaces(2);
        fc.pre(first.greaterThan(0) && first.lessThan(t));
        const rest = t.minus(first);
        const ok = deriveStages(total, [
          { name: 'A', basis: 'amount', amount: first.toFixed(2) },
          { name: 'B', basis: 'amount', amount: rest.toFixed(2) },
        ]);
        expect(ok.reduce((s, x) => s.plus(x.amount), new Decimal(0)).toFixed(2)).toBe(total);
        expect(() =>
          deriveStages(total, [
            { name: 'A', basis: 'amount', amount: first.toFixed(2) },
            { name: 'B', basis: 'amount', amount: rest.plus('0.01').toFixed(2) },
          ]),
        ).toThrow(ValidationError);
      }),
      { numRuns: 300 },
    );
  });
});
