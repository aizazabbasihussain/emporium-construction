import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money } from '../src/kernel/money.js';
import {
  allocatePayment,
  coveredQuantity,
  lineAmount,
  lineVariance,
  matchLine,
  vendorBalance,
} from '../src/payables/index.js';

const money = fc.integer({ min: 1, max: 5_000_000 }).map((cents) => (cents / 100).toFixed(2));

describe('payables properties (T-7)', () => {
  it('vendor balance equals the posted bills less the payments for random sequences', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ net: money, withholding: money }), { maxLength: 12 }),
        fc.array(money, { maxLength: 12 }),
        (bills, payments) => {
          const result = vendorBalance({
            bills: bills.map((b) => ({ netPayable: b.net, withholdingTotal: b.withholding })),
            allocated: payments,
          });
          const billed = bills.reduce(
            (s, b) => s.add(Money.of(b.net)).add(Money.of(b.withholding)),
            Money.zero(),
          );
          const paid = payments.reduce((s, p) => s.add(Money.of(p)), Money.zero());
          expect(result.balance).toBe(billed.sub(paid).toString());
        },
      ),
    );
  });

  it('cash plus withholding deducted always equals the allocations and nothing goes negative', () => {
    fc.assert(
      fc.property(
        money,
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (gross, withholdingPercent, takePercent) => {
          const withholdingTotal = Money.of(
            Number((Number(gross) * withholdingPercent) / 100).toFixed(2),
          );
          const allocation = Money.of(((Number(gross) * takePercent) / 100).toFixed(2));
          fc.pre(!allocation.isZero());
          const result = allocatePayment(
            [{ billId: 'b', amount: allocation.toString() }],
            [
              {
                billId: 'b',
                gross,
                withholdingTotal: withholdingTotal.toString(),
                allocated: '0.00',
                withheld: '0.00',
              },
            ],
          );
          expect(Money.of(result.amount).add(Money.of(result.withholdingDeducted)).toString()).toBe(
            allocation.toString(),
          );
          expect(Money.of(result.amount).isNegative()).toBe(false);
          expect(Money.of(result.withholdingDeducted).compare(withholdingTotal) <= 0).toBe(true);
        },
      ),
    );
  });

  it('the receipt cost plus the variance equals the billed amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (qty, openQty, rateCents) => {
          const q = (qty / 100).toFixed(2);
          const open = (openQty / 100).toFixed(2);
          const rate = (rateCents / 100).toFixed(4);
          const billed = lineAmount(q, rate);
          const covered = Math.min(qty, openQty) / 100;
          const receiptCost = lineAmount(covered.toFixed(2), rate);
          const result = matchLine({
            poRate: rate,
            receivedQty: open,
            billedBefore: '0',
            billedQty: q,
            billedRate: rate,
            qtyTolerancePercent: '0',
            rateTolerancePercent: '0',
          });
          const variance = lineVariance({
            billedAmount: billed,
            coveredQty: coveredQuantity(q, result.qtyVariance),
            poRate: rate,
          });
          expect(Money.of(receiptCost).add(Money.of(variance)).toString()).toBe(billed);
        },
      ),
    );
  });
});
