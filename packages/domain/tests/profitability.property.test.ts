import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  alertChanges,
  alertCodes,
  compareRisk,
  computeFinancials,
  percentOf,
} from '../src/profitability/index.js';

const money = fc.integer({ min: 0, max: 50_000_000 }).map((cents) => (cents / 100).toFixed(2));
const cents = (value: string) => BigInt(value.replace('.', ''));

describe('profitability invariants (T-5)', () => {
  it('cash position = collected - paid out; margins and balances follow their definitions', () => {
    fc.assert(
      fc.property(
        fc.record({
          contractValue: money,
          billed: fc.record({ base: money, tax: money, gross: money }),
          collected: fc.record({ gross: money, withheld: money, base: money }),
          cost: fc.record({ committed: money, approved: money, posted: money, budget: money }),
          paidOut: fc.record({ vendors: money, wages: money, expenses: money }),
          forecast: fc.option(money, { nil: null }),
        }),
        (input) => {
          const out = computeFinancials(input);
          expect(cents(out.cashPosition)).toBe(
            cents(input.collected.gross) -
              cents(input.paidOut.vendors) -
              cents(input.paidOut.wages) -
              cents(input.paidOut.expenses),
          );
          expect(cents(out.costToDate)).toBe(
            cents(input.cost.committed) + cents(input.cost.approved) + cents(input.cost.posted),
          );
          expect(cents(out.expectedMargin)).toBe(
            cents(input.contractValue) - cents(out.costToDate) - cents(out.costToComplete),
          );
          expect(cents(out.currentMargin)).toBe(
            cents(input.billed.base) - cents(input.cost.posted) - cents(input.cost.approved),
          );
          expect(cents(out.outstandingReceivable)).toBe(
            cents(input.billed.gross) - cents(input.collected.gross),
          );
          expect(cents(out.costToComplete)).toBeGreaterThanOrEqual(0n);
          // The percent of a non-zero base is always a number with two decimals; of a zero base, null.
          expect(out.billedPercent === null).toBe(cents(input.contractValue) === 0n);
          expect(out.costPercentOfBudget === null).toBe(cents(input.cost.budget) === 0n);
        },
      ),
    );
  });

  it('a percent is exact half-up to two decimals of part / whole x 100', () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 1, max: 50_000_000 }), (part, wholeCents) => {
        const whole = (wholeCents / 100).toFixed(2);
        const percent = percentOf(part, whole) as string;
        expect(percent).toMatch(/^\d+\.\d{2}$/);
        // percent / 100 x whole reproduces the part within half a unit of the last percent digit.
        const hundredths = BigInt(percent.replace('.', ''));
        const exact = cents(part) * 10000n; // part x 100 (percent) x 100 (two decimals), in cents
        const rounded = hundredths * BigInt(wholeCents);
        const half = BigInt(wholeCents) / 2n + 1n;
        expect(rounded - exact <= half && exact - rounded <= half).toBe(true);
      }),
    );
  });

  it('applying the changes of an alert comparison leaves exactly the conditions that hold', () => {
    const codes = fc.subarray([...alertCodes]);
    fc.assert(
      fc.property(codes, codes, (open, now) => {
        const { raise, clear } = alertChanges(open, now);
        const after = [...open.filter((code) => !clear.includes(code)), ...raise].sort();
        expect(after).toEqual([...now].sort());
        // An alert is never raised twice and never cleared if it was not open.
        expect(raise.every((code) => !open.includes(code))).toBe(true);
        expect(clear.every((code) => open.includes(code))).toBe(true);
      }),
    );
  });

  it('the risk order is a total preorder: sorting twice, in any input order, gives the same order', () => {
    const row = fc.record({
      alerts: fc.integer({ min: 0, max: 3 }),
      expectedMarginPercent: fc.option(
        fc.integer({ min: -10000, max: 10000 }).map((v) => (v / 100).toFixed(2)),
        { nil: null },
      ),
      cashPosition: fc.integer({ min: -1000000, max: 1000000 }).map((v) => (v / 100).toFixed(2)),
    });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 12 }), (rows) => {
        const once = [...rows].sort(compareRisk);
        expect(
          [...rows]
            .reverse()
            .sort(compareRisk)
            .map((r) => compareRisk(r, r)),
        ).toEqual(once.map(() => 0));
        for (let i = 1; i < once.length; i += 1) {
          expect(compareRisk(once[i - 1] as never, once[i] as never)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});
