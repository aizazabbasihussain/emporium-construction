import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  balanceOn,
  lowestBalanceFrom,
  reconciliationFigures,
  signed,
  type LedgerEntry,
} from '../src/cashbook/index.js';
import { Money } from '../src/kernel/money.js';

const entry = fc.record({
  direction: fc.constantFrom('in' as const, 'out' as const),
  amount: fc.integer({ min: 1, max: 1_000_000_00 }).map((c) => (c / 100).toFixed(2)),
  txnDate: fc.integer({ min: 1, max: 28 }).map((d) => `2026-11-${String(d).padStart(2, '0')}`),
});

describe('cash book balances (T-8)', () => {
  it('the balance equals the opening balance plus the signed entries, in any order', () => {
    fc.assert(
      fc.property(
        fc.array(entry, { maxLength: 30 }),
        fc.integer({ min: 0, max: 1e8 }),
        (entries, o) => {
          const opening = (o / 100).toFixed(2);
          const sum = entries.reduce(
            (s, x) => s.add(signed(x.direction, x.amount)),
            Money.of(opening),
          );
          expect(balanceOn(opening, entries, '2026-11-30').toString()).toBe(sum.toString());
          expect(balanceOn(opening, [...entries].reverse(), '2026-11-30').toString()).toBe(
            sum.toString(),
          );
        },
      ),
    );
  });

  it('a transfer nets to zero across accounts', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000_00 }), { maxLength: 20 }),
        (cents) => {
          const out: LedgerEntry[] = [];
          const into: LedgerEntry[] = [];
          for (const c of cents) {
            const amount = (c / 100).toFixed(2);
            out.push({ direction: 'out', amount, txnDate: '2026-11-01' });
            into.push({ direction: 'in', amount, txnDate: '2026-11-01' });
          }
          const net = balanceOn('0.00', out, '2026-11-30').add(
            balanceOn('0.00', into, '2026-11-30'),
          );
          expect(net.isZero()).toBe(true);
        },
      ),
    );
  });

  it('the lowest balance is never above the closing balance or the opening balance', () => {
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 30 }), (entries) => {
        const low = lowestBalanceFrom('0.00', entries, '2026-11-01');
        expect(low.compare(balanceOn('0.00', entries, '2026-11-30'))).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('a reconciliation built from consistent books and bank always has zero difference', () => {
    fc.assert(
      fc.property(
        fc.array(entry, { maxLength: 10 }),
        fc.array(entry, { maxLength: 10 }),
        fc.integer({ min: 0, max: 1e8 }),
        (bookOnly, bankOnly, o) => {
          const base = (o / 100).toFixed(2);
          const sign = (x: LedgerEntry) => signed(x.direction, x.amount);
          const sum = (xs: LedgerEntry[]) => xs.reduce((s, x) => s.add(sign(x)), Money.zero());
          // The bank saw the opening plus the bank-only items; the books saw the opening plus the book-only items.
          const book = Money.of(base).add(sum(bookOnly));
          const statement = Money.of(base).add(sum(bankOnly));
          const figures = reconciliationFigures({
            statementClosingBalance: statement.toString(),
            bookBalance: book.toString(),
            unreconciledBook: bookOnly,
            unreconciledStatement: bankOnly.map((x) =>
              x.direction === 'in'
                ? { debit: '0.00', credit: x.amount }
                : { debit: x.amount, credit: '0.00' },
            ),
          });
          expect(figures.difference).toBe('0.00');
        },
      ),
    );
  });
});
