import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money } from '../src/kernel/money.js';
import { ageItems, suggestAllocation, validateAllocations } from '../src/receivables/index.js';

const cents = fc.integer({ min: 1, max: 5_000_000 }).map((c) => (c / 100).toFixed(2));

describe('receivables invariants (T-7)', () => {
  it('a suggestion never exceeds the money or an invoice and uses the money when it can', () => {
    fc.assert(
      fc.property(
        cents,
        fc.array(cents, { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 1, max: 365 }), { minLength: 8, maxLength: 8 }),
        (amount, rooms, days) => {
          const items = rooms.map((allocatable, i) => ({
            invoiceId: `i${i}`,
            dueDate: `2026-${String(1 + Math.floor((days[i] as number) / 31)).padStart(2, '0')}-${String(1 + ((days[i] as number) % 28)).padStart(2, '0')}`,
            allocatable,
          }));
          const out = suggestAllocation(amount, items);
          const used = out.reduce((s, l) => s.add(Money.of(l.amount)), Money.zero());
          const capacity = items.reduce((s, l) => s.add(Money.of(l.allocatable)), Money.zero());
          const expected = Money.of(amount).compare(capacity) < 0 ? Money.of(amount) : capacity;
          expect(used.toString()).toBe(expected.toString());
          for (const line of out) {
            const item = items.find((x) => x.invoiceId === line.invoiceId);
            expect(
              Money.of(line.amount).compare(Money.of(item?.allocatable ?? '0')),
            ).toBeLessThanOrEqual(0);
          }
          // A suggestion is always a valid allocation of that much money.
          if (out.length > 0) {
            expect(() =>
              validateAllocations({
                receiptAmount: used.toString(),
                withheldAmount: '0',
                allocations: out.map((l) => ({ kind: 'invoice', ...l })),
                allocatable: new Map(items.map((x) => [x.invoiceId, x.allocatable])),
              }),
            ).not.toThrow();
          }
        },
      ),
    );
  });

  it('the aging total equals the sum of the open amounts, whatever the date', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.constantFrom('a', 'b', 'c'),
            due: fc.integer({ min: 0, max: 400 }),
            amount: cents,
          }),
          {
            maxLength: 25,
          },
        ),
        fc.integer({ min: 0, max: 400 }),
        (rows, asOf) => {
          const date = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
          const report = ageItems(
            rows.map((r) => ({ key: r.key, dueDate: date(r.due), outstanding: r.amount })),
            date(asOf),
            [30, 60, 90],
          );
          const sum = rows.reduce((s, r) => s.add(Money.of(r.amount)), Money.zero());
          expect(report.total).toBe(sum.toString());
          expect(
            report.rows.reduce((s, r) => s.add(Money.of(r.total)), Money.zero()).toString(),
          ).toBe(sum.toString());
        },
      ),
    );
  });
});
