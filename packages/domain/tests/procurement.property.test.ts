import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  lineTotal,
  maxAcceptable,
  normalizePoLines,
  receiptCost,
  remainingCommitment,
  sumMoney,
} from '../src/procurement/index.js';

const quantity = fc
  .tuple(fc.integer({ min: 1, max: 99_999 }), fc.integer({ min: 0, max: 9999 }))
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(4, '0')}`);
const rate = fc
  .tuple(fc.integer({ min: 0, max: 99_999 }), fc.integer({ min: 0, max: 9999 }))
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(4, '0')}`);

describe('procurement properties (T-1)', () => {
  it('the PO total equals the sum of the line totals for random lines', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(quantity, rate), { minLength: 1, maxLength: 12 }), (rows) => {
        const { lines, total } = normalizePoLines(
          rows.map(([q, r]) => ({
            itemId: 'i',
            quantity: q,
            unitCode: 'nos',
            rate: r,
            costCodeId: 'c',
          })),
        );
        expect(total).toBe(sumMoney(lines.map((line) => line.lineTotal)));
        for (const line of lines) expect(line.lineTotal).toBe(lineTotal(line.quantity, line.rate));
      }),
    );
  });

  it('a line total is within half a paisa of the exact product', () => {
    fc.assert(
      fc.property(quantity, rate, (q, r) => {
        const exact = Number(q) * Number(r);
        expect(Math.abs(Number(lineTotal(q, r)) - exact)).toBeLessThanOrEqual(0.0051);
      }),
    );
  });

  it('commitment is conserved: receipt cost plus what stays committed covers the line total', () => {
    fc.assert(
      fc.property(quantity, rate, fc.integer({ min: 0, max: 100 }), (q, r, pct) => {
        const total = lineTotal(q, r);
        const part = receiptCost(((Number(q) * pct) / 100).toFixed(4), r);
        const remaining = remainingCommitment(total, part);
        expect(Number(remaining)).toBeGreaterThanOrEqual(0);
        if (Number(part) <= Number(total)) {
          expect(sumMoney([part, remaining])).toBe(total);
        }
      }),
    );
  });

  it('the acceptable quantity grows with the tolerance and shrinks with receipts', () => {
    fc.assert(
      fc.property(quantity, fc.integer({ min: 0, max: 20 }), (ordered, tol) => {
        const none = Number(maxAcceptable(ordered, '0', '0'));
        expect(none).toBeCloseTo(Number(ordered), 4);
        expect(Number(maxAcceptable(ordered, '0', String(tol)))).toBeGreaterThanOrEqual(none);
        expect(Number(maxAcceptable(ordered, ordered, '0'))).toBe(0);
      }),
    );
  });
});
