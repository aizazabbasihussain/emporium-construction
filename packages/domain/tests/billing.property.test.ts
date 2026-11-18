import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  advanceRecovery,
  computeCredit,
  grossTotal,
  spreadReduction,
  taxableBase,
  type CreditedInvoice,
} from '../src/billing/index.js';
import { Money } from '../src/kernel/money.js';
import { calculateSalesTax } from '../src/tax/calculate.js';

const RULE = { id: 'r1', authorityCode: 'FBR', taxCode: 'TEST-ST', ratePercent: '10' };
const taxOf = (taxable: string) =>
  calculateSalesTax([{ id: 'l', amount: taxable, rule: RULE }], {
    roundingMode: 'per_document',
    pricesIncludeTax: false,
  });

describe('spreading a reduction over lines (BR-3)', () => {
  it('the reduced lines always add up to the total less the reduction', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100_000_00 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 100 }),
        (cents, percent) => {
          const lines = cents.map((c) => (c / 100).toFixed(2));
          const total = lines.reduce((s, l) => s.add(Money.of(l)), Money.zero());
          const reduction = Money.of(total.value.times(percent).div(100));
          const out = spreadReduction(lines, reduction.toString());
          const sum = out.reduce((s, l) => s.add(Money.of(l)), Money.zero());
          expect(sum.toString()).toBe(total.sub(reduction).toString());
        },
      ),
    );
  });
});

describe('credit notes (T-6, T-3)', () => {
  it('never exceed the invoice, and a completed series equals it exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000_00 }),
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 6 }),
        (baseCents, recoveryShare, atReceiptFlag, weights) => {
          const base = Money.of((baseCents / 100).toFixed(2));
          const recovery = Money.of(base.value.times(recoveryShare).div(100));
          const taxable = atReceiptFlag ? base : base.sub(recovery);
          const tax = Money.of(taxable.value.times(16).div(100));
          const invoice: CreditedInvoice = {
            baseAmount: base.toString(),
            advanceRecovery: recovery.toString(),
            taxTotal: tax.toString(),
            taxOnAdvanceAtReceipt: atReceiptFlag,
            taxGroups: [{ base: taxable.toString(), ratePercent: '16' }],
          };
          const total = weights.reduce((a, b) => a + b, 0);
          let prior = { base: '0.00', advanceRestored: '0.00', tax: '0.00' };
          let gross = Money.zero();
          let creditedBase = Money.zero();
          for (const [index, weight] of weights.entries()) {
            const last = index === weights.length - 1;
            const share = last
              ? base.sub(creditedBase)
              : Money.of(base.value.times(weight).div(total));
            if (!share.value.gt(0) || share.compare(base.sub(creditedBase)) > 0) continue;
            const credit = computeCredit(invoice, prior, share.toString());
            prior = {
              base: Money.of(prior.base).add(Money.of(credit.baseAmount)).toString(),
              advanceRestored: Money.of(prior.advanceRestored)
                .add(Money.of(credit.advanceRestored))
                .toString(),
              tax: Money.of(prior.tax).add(Money.of(credit.taxTotal)).toString(),
            };
            gross = gross.add(Money.of(credit.grossTotal));
            creditedBase = creditedBase.add(share);
            expect(Money.of(prior.base).compare(base)).toBeLessThanOrEqual(0);
            expect(Money.of(prior.tax).compare(tax)).toBeLessThanOrEqual(0);
            expect(Money.of(prior.advanceRestored).compare(recovery)).toBeLessThanOrEqual(0);
          }
          if (creditedBase.equals(base)) {
            const invoiceGross = atReceiptFlag ? taxable.add(tax).sub(recovery) : taxable.add(tax);
            expect(gross.toString()).toBe(invoiceGross.toString());
            expect(prior.tax).toBe(tax.toString());
            expect(prior.advanceRestored).toBe(recovery.toString());
          }
        },
      ),
    );
  });
});

describe('invoice arithmetic (T-3)', () => {
  it('recovery never exceeds the advance, billed base never exceeds the contract, totals add up', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000_00 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 100 }),
        fc.constantFrom('proportional' as const, 'fixed_percent' as const),
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        (stageCents, advancePercent, method, fixedPercent, atReceipt) => {
          const stages = stageCents.map((c) => Money.of((c / 100).toFixed(2)));
          const contract = stages.reduce((s, m) => s.add(m), Money.zero());
          const advance = Money.of(contract.value.times(advancePercent).div(100));
          let unapplied = advance;
          let remaining = contract;
          let billed = Money.zero();
          let recovered = Money.zero();
          for (const stage of stages) {
            const recovery = Money.of(
              advanceRecovery({
                method,
                unapplied: unapplied.toString(),
                invoiceBase: stage.toString(),
                remainingUnbilled: remaining.toString(),
                fixedPercent: String(fixedPercent),
              }),
            );
            expect(recovery.compare(unapplied)).toBeLessThanOrEqual(0);
            expect(recovery.compare(stage)).toBeLessThanOrEqual(0);
            const taxable = taxableBase(stage.toString(), recovery.toString(), atReceipt);
            const tax = taxOf(taxable).taxTotal;
            const gross = grossTotal(taxable, tax, recovery.toString(), atReceipt);
            expect(gross).toBe(
              Money.of(taxable)
                .add(Money.of(tax))
                .sub(atReceipt ? recovery : Money.zero())
                .toString(),
            );
            unapplied = unapplied.sub(recovery);
            remaining = remaining.sub(stage);
            recovered = recovered.add(recovery);
            billed = billed.add(stage);
            expect(billed.compare(contract)).toBeLessThanOrEqual(0);
            expect(recovered.compare(advance)).toBeLessThanOrEqual(0);
          }
          if (method === 'proportional') expect(recovered.toString()).toBe(advance.toString());
        },
      ),
    );
  });
});
