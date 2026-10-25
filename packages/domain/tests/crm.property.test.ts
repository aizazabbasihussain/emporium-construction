import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sumExpectedValue, summarizePipeline } from '../src/crm/rules.js';

const stages = ['new', 'visited', 'quoted', 'won', 'lost'] as const;
const amount = fc
  .tuple(fc.integer({ min: 0, max: 999_999_999 }), fc.integer({ min: 0, max: 99 }))
  .map(([whole, cents]) => `${whole}.${String(cents).padStart(2, '0')}`);
const lead = fc.record({
  stageCode: fc.constantFrom(...stages),
  expectedValue: fc.option(amount, { nil: null }),
});

const toCents = (value: string | null) => (value === null ? 0n : BigInt(value.replace('.', '')));

describe('pipeline invariants (spec P1-06 T-5)', () => {
  it('the stage rows add up to the leads: count and expected value are conserved', () => {
    fc.assert(
      fc.property(fc.array(lead, { maxLength: 40 }), (leads) => {
        const rows = summarizePipeline(stages, leads);
        expect(rows.reduce((n, row) => n + row.count, 0)).toBe(leads.length);
        const total = rows.reduce((sum, row) => sum + toCents(row.expectedValue), 0n);
        expect(total).toBe(leads.reduce((sum, l) => sum + toCents(l.expectedValue), 0n));
        expect(sumExpectedValue(leads.map((l) => l.expectedValue))).toBe(
          `${total / 100n}.${String(total % 100n).padStart(2, '0')}`,
        );
      }),
    );
  });
});
