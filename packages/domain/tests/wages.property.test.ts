import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  calculateBasicPay,
  periodTotals,
  reconcile,
  settleLine,
  sumMoney,
  type DayInput,
  type WageSettings,
} from '../src/wages/index.js';
import { entryStatuses } from '../src/attendance/index.js';

const cents = fc.integer({ min: 0, max: 90_000_000 });
const money = (value: number) => (value / 100).toFixed(2);

const settings: WageSettings = {
  workingDaysBasis: 26,
  overtimeMultiplier: '1.5',
  payOffDaysDaily: false,
  roundNetToRupee: false,
};

const day = fc.record({
  status: fc.constantFrom(...entryStatuses),
  overtimeHours: fc.integer({ min: 0, max: 8 }).map(String),
  payBasis: fc.constantFrom('daily_rate' as const, 'monthly_salary' as const),
  amount: fc.integer({ min: 1, max: 200_000 }).map(String),
});

const days = fc.array(day, { minLength: 1, maxLength: 31 }).map((list): DayInput[] =>
  list.map((item, index) => ({
    ...item,
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    dailyEquivalent: (Number(item.amount) / (item.payBasis === 'daily_rate' ? 1 : 26)).toFixed(4),
  })),
);

const advance = fc.record({
  id: fc.uuid(),
  monthlyRecovery: cents.map(money),
  balance: cents.map(money),
});

describe('wage invariants (T-7)', () => {
  it('net = gross - deductions - recovery (+ shortfall, + rounding) for random inputs', () => {
    fc.assert(
      fc.property(
        cents,
        cents,
        cents,
        cents,
        fc.array(advance, { maxLength: 4 }),
        fc.boolean(),
        (basic, overtime, allowances, deductions, advances, round) => {
          const result = settleLine({
            basicPay: money(basic),
            overtimePay: money(overtime),
            allowances: money(allowances),
            deductions: money(deductions),
            advances,
            roundNetToRupee: round,
          });
          const cent = (text: string) => Math.round(Number(text) * 100);
          const gross = basic + overtime + allowances;
          expect(cent(result.grossPay)).toBe(gross);
          expect(cent(result.netPay)).toBe(
            gross -
              cent(result.deductions) -
              cent(result.advanceRecovery) +
              cent(result.shortfall) +
              cent(result.roundingAdjustment),
          );
          expect(cent(result.netPay)).toBeGreaterThanOrEqual(0);
          expect(cent(result.advanceRecovery)).toBeLessThanOrEqual(Math.max(gross - deductions, 0));
          if (round) expect(cent(result.netPay) % 100).toBe(0);
          else expect(result.roundingAdjustment).toBe('0.00');
          expect(sumMoney(result.recoveries.map((item) => item.amount))).toBe(
            result.advanceRecovery,
          );
        },
      ),
    );
  });

  it('never recovers more than an instalment or a balance', () => {
    fc.assert(
      fc.property(cents, fc.array(advance, { maxLength: 4 }), (basic, advances) => {
        const result = settleLine({
          basicPay: money(basic),
          overtimePay: '0.00',
          allowances: '0.00',
          deductions: '0.00',
          advances,
          roundNetToRupee: false,
        });
        for (const item of result.recoveries) {
          const source = advances.find((a) => a.id === item.advanceId);
          expect(Number(item.amount)).toBeLessThanOrEqual(Number(source?.monthlyRecovery));
          expect(Number(item.amount)).toBeLessThanOrEqual(Number(source?.balance));
        }
      }),
    );
  });

  it('calculating twice gives identical results, in any order of the days', () => {
    fc.assert(
      fc.property(days, (list) => {
        const first = calculateBasicPay(list, settings);
        expect(calculateBasicPay(list, settings)).toEqual(first);
        expect(calculateBasicPay([...list].reverse(), settings)).toEqual(first);
      }),
    );
  });

  it('a salaried worker never earns more than the highest salary of the month', () => {
    fc.assert(
      fc.property(days, (list) => {
        const pay = calculateBasicPay(
          list.map((item) => ({ ...item, payBasis: 'monthly_salary' as const })),
          settings,
        );
        const highest = Math.max(...list.map((item) => Number(item.amount)));
        expect(Number(pay.basicPay)).toBeLessThanOrEqual(highest + 0.01);
      }),
    );
  });

  it('the totals of a period equal the sum of its lines', () => {
    fc.assert(
      fc.property(fc.array(cents, { minLength: 0, maxLength: 20 }), (values) => {
        const lines = values.map((value) => {
          const result = settleLine({
            basicPay: money(value),
            overtimePay: '0.00',
            allowances: '0.00',
            deductions: '0.00',
            advances: [],
            roundNetToRupee: true,
          });
          return {
            basicPay: money(value),
            overtimePay: '0.00',
            allowances: '0.00',
            deductions: '0.00',
            advanceRecovery: result.advanceRecovery,
            grossPay: result.grossPay,
            netPay: result.netPay,
            roundingAdjustment: result.roundingAdjustment,
          };
        });
        const totals = periodTotals(lines);
        expect(totals.netPay).toBe(sumMoney(lines.map((line) => line.netPay)));
        expect(totals.grossPay).toBe(sumMoney(lines.map((line) => line.grossPay)));
      }),
    );
  });

  it('the reconciliation difference is gross less allocated in total', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(cents, cents), { maxLength: 10 }), (pairs) => {
        const allocated = new Map(pairs.map(([a], i) => [`w${i}`, money(a)]));
        const gross = new Map(pairs.map(([, g], i) => [`w${i}`, money(g)]));
        const result = reconcile(allocated, gross);
        expect(Math.round(Number(result.totals.difference) * 100)).toBe(
          pairs.reduce((total, [a, g]) => total + g - a, 0),
        );
      }),
    );
  });
});
