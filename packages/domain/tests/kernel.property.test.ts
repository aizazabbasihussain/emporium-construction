import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money, Quantity, roundMoney } from '../src/kernel/money.js';

// Property tests live outside src/ because the domain-stays-pure rule keeps test libraries out of it.
const cents = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });
const asMoney = (c: number) => Money.of(new Decimal(c).div(100));

describe('kernel value objects (property tests, T-2)', () => {
  it('property: addition is associative, commutative and exact (T-2)', () => {
    fc.assert(
      fc.property(cents, cents, cents, (x, y, z) => {
        const [a, b, c] = [asMoney(x), asMoney(y), asMoney(z)];
        expect(
          a
            .add(b)
            .add(c)
            .equals(a.add(b.add(c))),
        ).toBe(true);
        expect(a.add(b).equals(b.add(a))).toBe(true);
        expect(a.add(b).add(c).toString()).toBe(asMoney(x + y + z).toString());
        expect(a.add(b).sub(b).equals(a)).toBe(true);
      }),
    );
  });

  it('property: roundMoney is half-up for 1,000 random values (T-2)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000_000, max: 100_000_000 }), (thousandths) => {
        const exact = new Decimal(thousandths).div(1000);
        const expected = exact.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
        const sign = thousandths < 0 ? -1 : 1;
        const abs = Math.abs(thousandths);
        const manual = (sign * (Math.floor(abs / 10) + (abs % 10 >= 5 ? 1 : 0))) / 100;
        expect(roundMoney(Money.of(new Decimal(thousandths).div(1000))).toString()).toBe(expected);
        expect(Number(expected)).toBeCloseTo(manual, 10);
      }),
      { numRuns: 1000 },
    );
  });

  it('property: never loses precision on 4 decimals (T-2)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000_000 }),
        (x, y) => {
          const [a, b] = [new Decimal(x).div(10_000), new Decimal(y).div(10_000)];
          const sum = Quantity.of(a.toFixed(4)).add(Quantity.of(b.toFixed(4)));
          expect(sum.toString()).toBe(a.plus(b).toFixed(4));
          expect(Quantity.of(sum.toString()).equals(sum)).toBe(true);
        },
      ),
    );
  });
});
