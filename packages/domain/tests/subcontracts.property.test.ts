import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money } from '../src/kernel/money.js';
import {
  certificateFigures,
  currentContractAmount,
  remainingCommitment,
} from '../src/subcontracts/index.js';

const money = (max: number) => fc.integer({ min: 1, max }).map((cents) => (cents / 100).toFixed(2));

describe('subcontracts properties (T-1)', () => {
  it('cumulative never exceeds the contract plus variations and certificates sum to the cumulative', () => {
    fc.assert(
      fc.property(
        money(100_000_000),
        fc.array(fc.integer({ min: -50_000, max: 5_000_000 }), { maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 8 }),
        (contract, variationCents, percentSteps) => {
          const variations = variationCents
            .filter((cents) => cents !== 0)
            .map((cents) => (cents / 100).toFixed(2));
          const current = currentContractAmount(contract, variations);
          if (Money.of(current).isNegative() || Money.of(current).isZero()) return;
          let previous = '0.00';
          let sum = Money.zero();
          let percent = 0;
          for (const step of percentSteps) {
            percent = Math.min(10_000, percent + step);
            let figures;
            try {
              figures = certificateFigures({
                basis: 'percent_complete',
                contractAmount: current,
                previousCumulative: previous,
                cumulativePercent: (percent / 100).toFixed(2),
                deductions: '0',
              });
            } catch {
              continue; // no new work in this step
            }
            expect(
              Money.of(figures.cumulativeAmount).compare(Money.of(current)),
            ).toBeLessThanOrEqual(0);
            sum = sum.add(Money.of(figures.thisCertificateAmount));
            expect(sum.toString()).toBe(figures.cumulativeAmount);
            expect(
              Money.of(figures.cumulativeAmount)
                .add(Money.of(remainingCommitment(current, figures.cumulativeAmount)))
                .toString(),
            ).toBe(current);
            previous = figures.cumulativeAmount;
          }
        },
      ),
    );
  });

  it('gross less deductions is the net, and net is never negative', () => {
    fc.assert(
      fc.property(money(10_000_000), money(10_000_000), (gross, deduction) => {
        try {
          const figures = certificateFigures({
            basis: 'amount',
            contractAmount: '1000000000.00',
            previousCumulative: '0',
            cumulativeAmount: gross,
            deductions: deduction,
          });
          expect(Money.of(figures.netCertified).isNegative()).toBe(false);
          expect(
            Money.of(figures.thisCertificateAmount).sub(Money.of(figures.deductions)).toString(),
          ).toBe(figures.netCertified);
        } catch (error) {
          expect((error as { code: string }).code).toBe('negative_net');
          expect(Money.of(deduction).compare(Money.of(gross))).toBeGreaterThan(0);
        }
      }),
    );
  });
});
