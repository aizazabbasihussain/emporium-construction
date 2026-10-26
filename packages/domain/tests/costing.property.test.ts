import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { summarizeChains, type ChainRow, type CostStatus } from '../src/costing/index.js';

const row = (seq: number, chain: string, status: CostStatus, amount: string): ChainRow => ({
  seq,
  chain,
  costCodeId: 'c',
  amount,
  status,
});

const progression = ['committed', 'approved', 'posted'] as const;

describe('cost ledger chains (P1-09 T-5)', () => {
  it('reversing every chain yields zero, whatever the sequence', () => {
    const steps = fc.array(
      fc.record({
        chain: fc.integer({ min: 0, max: 4 }),
        amount: fc.integer({ min: 1, max: 10_000_000 }),
      }),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(steps, (list) => {
        const rows: ChainRow[] = [];
        const seen = new Set<number>();
        for (const { chain, amount } of list) {
          if (seen.has(chain)) continue;
          seen.add(chain);
          const money = (amount / 100).toFixed(2);
          for (const status of progression) {
            rows.push(row(rows.length + 1, `k${chain}`, status, money));
          }
        }
        const before = summarizeChains(rows);
        expect(before.committed).toBe('0.00');
        for (const chain of seen) {
          const last = rows.filter((r) => r.chain === `k${chain}`).at(-1) as ChainRow;
          rows.push(row(rows.length + 1, `k${chain}`, 'reversed', last.amount));
        }
        expect(summarizeChains(rows)).toEqual({
          committed: '0.00',
          approved: '0.00',
          posted: '0.00',
        });
      }),
    );
  });

  it('summary totals equal the sum of the latest row of each chain', () => {
    const chains = fc.array(
      fc.record({
        amount: fc.integer({ min: 1, max: 10_000_000 }),
        steps: fc.integer({ min: 1, max: 3 }),
      }),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(chains, (list) => {
        const rows: ChainRow[] = [];
        const expected = {
          committed: new Decimal(0),
          approved: new Decimal(0),
          posted: new Decimal(0),
        };
        list.forEach(({ amount, steps }, index) => {
          const money = (amount / 100).toFixed(2);
          for (const status of progression.slice(0, steps)) {
            rows.push(row(rows.length + 1, `k${index}`, status, money));
          }
          expected[progression[steps - 1] as CostStatus & keyof typeof expected] =
            expected[progression[steps - 1] as CostStatus & keyof typeof expected].plus(money);
        });
        expect(summarizeChains(rows)).toEqual({
          committed: expected.committed.toFixed(2),
          approved: expected.approved.toFixed(2),
          posted: expected.posted.toFixed(2),
        });
      }),
    );
  });
});
