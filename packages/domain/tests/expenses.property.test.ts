import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { claimTotal, custodianBalance, normalizeClaimLines } from '../src/expenses/index.js';

const cents = fc.integer({ min: 1, max: 9_000_000_000 });
const money = (value: number) => (value / 100).toFixed(2);

describe('expense claim money invariants (T-7)', () => {
  it('the claim total is the sum of the line amounts, in any order', () => {
    fc.assert(
      fc.property(fc.array(cents, { minLength: 1, maxLength: 12 }), (amounts) => {
        const lines = normalizeClaimLines(
          amounts.map((amount) => ({
            expenseDate: '2026-10-20',
            category: 'transport',
            description: 'line',
            costObjectType: 'overhead' as const,
            costCodeId: 'code',
            amount: money(amount),
          })),
        );
        const expected = money(amounts.reduce((sum, amount) => sum + amount, 0));
        expect(claimTotal(lines)).toBe(expected);
        expect(claimTotal([...lines].reverse())).toBe(expected);
      }),
    );
  });

  it('a custodian balance is advances minus approved and posted claims, whatever the order', () => {
    fc.assert(
      fc.property(
        fc.array(cents, { maxLength: 8 }),
        fc.array(cents, { maxLength: 8 }),
        (advances, claims) => {
          const expected = money(
            advances.reduce((sum, amount) => sum + amount, 0) -
              claims.reduce((sum, amount) => sum + amount, 0),
          );
          const balance = (a: number[], c: number[]) =>
            custodianBalance(
              a.map((amount) => ({ amount: money(amount), status: 'issued' as const })),
              c.map((total) => ({ total: money(total), status: 'posted' as const })),
            );
          expect(balance(advances, claims)).toBe(expected);
          expect(balance([...advances].reverse(), [...claims].reverse())).toBe(expected);
        },
      ),
    );
  });
});
