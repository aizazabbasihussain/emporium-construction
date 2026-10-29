import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BusinessDate } from '../src/kernel/index.js';
import {
  dailyEquivalent,
  periodAt,
  planPeriodInsert,
  type Period,
} from '../src/workforce/index.js';

const day = (n: number) => BusinessDate.parse('2026-01-01').addDays(n).toString();

/** Non-overlapping periods: sorted cut points; the last one may stay open. */
const periodsArb = fc
  .uniqueArray(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 12 })
  .chain((points) =>
    fc.boolean().map((openEnd) => {
      const sorted = [...points].sort((a, b) => a - b);
      return sorted.map((from, i): Period => {
        const next = sorted[i + 1];
        const to = next !== undefined ? day(next - 1) : openEnd ? null : day(from + 30);
        return { id: `p${i}`, from: day(from), to };
      });
    }),
  );

describe('workforce period invariants', () => {
  it('a lookup returns the period that contains the date, and none for a gap', () => {
    fc.assert(
      fc.property(periodsArb, fc.integer({ min: -20, max: 480 }), (periods, offset) => {
        const date = day(offset);
        const found = periodAt(periods, date);
        const containing = periods.filter((p) => p.from <= date && (p.to === null || date <= p.to));
        expect(containing.length).toBeLessThanOrEqual(1);
        expect(found).toBe(containing[0]);
      }),
      { seed: 16 },
    );
  });

  it('adding an open period after all others keeps the periods apart', () => {
    fc.assert(
      fc.property(periodsArb, fc.integer({ min: 1, max: 100 }), (periods, gap) => {
        const last = periods.at(-1) as Period;
        const lastDay = last.to === null ? last.from : last.to;
        const from = BusinessDate.parse(lastDay).addDays(gap).toString();
        const plan = planPeriodInsert(periods, { from, to: null }, 'overlap');
        const after = periods.map((p) =>
          p.id === plan.close?.id ? { ...p, to: plan.close.to } : p,
        );
        after.push({ id: 'new', from, to: null });
        // The day before the new start belongs to the old open period, never to two periods.
        for (let n = 0; n < 500; n += 7) {
          const date = day(n);
          expect(
            after.filter((p) => p.from <= date && (p.to === null || date <= p.to)).length,
          ).toBeLessThanOrEqual(1);
        }
      }),
      { seed: 16 },
    );
  });

  it('a monthly salary over the basis, times the basis, stays within rounding of the salary', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 1, max: 31 }),
        (rupees, basis) => {
          const daily = Number(
            dailyEquivalent({ payBasis: 'monthly_salary', amount: String(rupees) }, basis),
          );
          expect(Math.abs(daily * basis - rupees)).toBeLessThanOrEqual(basis * 0.00005 + 1e-6);
        },
      ),
      { seed: 16 },
    );
  });
});
