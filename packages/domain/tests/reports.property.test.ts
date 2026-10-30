import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  costStatus,
  sumDecimals,
  totalCostStatus,
  type CostFigures,
} from '../src/reports/index.js';

describe('totals (T-6)', () => {
  const figures = fc.record({
    budget: fc.integer({ min: 0, max: 10_000_000 }).map((n) => (n / 100).toFixed(2)),
    committed: fc.integer({ min: 0, max: 10_000_000 }).map((n) => (n / 100).toFixed(2)),
    approved: fc.integer({ min: 0, max: 10_000_000 }).map((n) => (n / 100).toFixed(2)),
    posted: fc.integer({ min: 0, max: 10_000_000 }).map((n) => (n / 100).toFixed(2)),
  });
  const cents = (value: string): bigint => BigInt(value.replace('.', ''));

  it('the sum of the per-cost-code figures is the project total, for random ledgers', () => {
    fc.assert(
      fc.property(fc.array(figures, { maxLength: 30 }), (lines: CostFigures[]) => {
        const total = totalCostStatus(lines);
        const sum = (pick: (line: CostFigures) => string) =>
          lines.reduce((acc, line) => acc + cents(pick(line)), 0n);
        expect(cents(total.budget)).toBe(sum((l) => l.budget));
        expect(cents(total.committed)).toBe(sum((l) => l.committed));
        expect(cents(total.approved)).toBe(sum((l) => l.approved));
        expect(cents(total.posted)).toBe(sum((l) => l.posted));
        // Used is the sum of the three statuses, and the variance closes the budget exactly.
        expect(cents(total.used)).toBe(
          cents(total.committed) + cents(total.approved) + cents(total.posted),
        );
        expect(cents(total.variance)).toBe(cents(total.budget) - cents(total.used));
        const perCode = lines.map((line) => costStatus(line));
        expect(cents(sumDecimals(perCode.map((l) => l.used)))).toBe(cents(total.used));
        expect(cents(sumDecimals(perCode.map((l) => l.variance)))).toBe(cents(total.variance));
      }),
    );
  });
});
