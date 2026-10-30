import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  entryAmounts,
  entryCost,
  normalizeEntries,
  splitAmount,
  sumAmounts,
} from '../src/attendance/index.js';

const cents = fc.integer({ min: 0, max: 900_000_000 });
const money = (value: number) => (value / 100).toFixed(2);

/** Fractions with four decimals that add up to exactly 1 (in ten-thousandths). */
const shares = fc
  .array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 6 })
  .map((parts) => {
    const total = parts.reduce((sum, part) => sum + part, 0);
    const scaled = parts.map((part) => Math.max(1, Math.floor((part * 10_000) / total)));
    const rest = 10_000 - scaled.reduce((sum, part) => sum + part, 0);
    // Put the remainder on the first share; a negative remainder is taken from the largest.
    const largest = scaled.indexOf(Math.max(...scaled));
    const target = rest >= 0 ? 0 : largest;
    scaled[target] = (scaled[target] as number) + rest;
    return scaled.map((part) => (part / 10_000).toFixed(4));
  })
  .filter((fractions) => fractions.every((f) => Number(f) > 0));

describe('attendance cost invariants (T-2)', () => {
  it('the lines of a split always add up to the day value exactly and are never negative', () => {
    fc.assert(
      fc.property(cents, shares, (value, fractions) => {
        const lines = splitAmount(money(value), fractions);
        expect(lines).toHaveLength(fractions.length);
        expect(sumAmounts(lines)).toBe(money(value));
        expect(lines.every((line) => Number(line) >= 0)).toBe(true);
      }),
    );
  });

  it('the total cost of a sheet equals the sum of its entry-allocation lines', () => {
    const entry = fc.record({
      status: fc.constantFrom('present', 'half_day', 'absent', 'leave_paid', 'off'),
      rate: fc.integer({ min: 100_00, max: 9_999_00 }),
      hours: fc.integer({ min: 0, max: 800 }),
      fractions: shares,
      ownOvertimeProject: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 8 }), (entries) => {
        let expected = 0;
        const lines: string[] = [];
        for (const [index, item] of entries.entries()) {
          const worked = item.status === 'present' || item.status === 'half_day';
          const [normalized] = normalizeEntries([
            {
              workerId: `w${index}`,
              status: item.status,
              overtimeHours: worked ? (item.hours / 100).toFixed(2) : '0',
              overtimeProjectId: worked && item.hours > 0 && item.ownOvertimeProject ? 'px' : null,
              allocations: worked
                ? item.fractions.map((fraction, i) => ({ projectId: `p${i}`, fraction }))
                : [],
            },
          ]);
          const cost = entryCost({
            status: item.status,
            dailyRate: money(item.rate),
            overtimeHours: normalized?.overtimeHours ?? '0',
            multiplier: '1.5',
          });
          const amounts = entryAmounts({
            allocations: normalized?.allocations ?? [],
            overtimeProjectId: normalized?.overtimeProjectId ?? null,
            ...cost,
          });
          lines.push(
            ...amounts.allocations,
            ...(amounts.overtime === null ? [] : [amounts.overtime]),
          );
          expected +=
            Math.round(Number(cost.dayValue) * 100) + Math.round(Number(cost.overtimeValue) * 100);
        }
        expect(sumAmounts(lines)).toBe(money(expected));
      }),
    );
  });
});
