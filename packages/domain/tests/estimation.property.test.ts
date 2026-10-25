import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  estimateTotals,
  lineKinds,
  lineTotal,
  suppliers,
  type CostLine,
  type EstimateTerms,
} from '../src/estimation/costing.js';
import { evaluateFormula } from '../src/estimation/formula.js';

const quantity = fc
  .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 9999 }))
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(4, '0')}`);
const rate = quantity;
const line = fc.record({
  lineKind: fc.constantFrom(...lineKinds),
  quantity,
  rate,
  suppliedBy: fc.constantFrom(...suppliers),
});
const percent = fc.integer({ min: 0, max: 100 }).map(String);
const terms = fc.record({
  overheadPercent: percent,
  contingencyPercent: percent,
  targetMarginPercent: percent,
  proposedPrice: fc.option(
    fc.integer({ min: 0, max: 100_000_000 }).map((n) => `${n}.00`),
    { nil: null },
  ),
});

const sum = (values: string[]) => values.reduce((total, v) => total.plus(v), new Decimal(0));

describe('estimate invariants (spec P1-07 T-4)', () => {
  it('total cost equals company cost plus overhead plus contingency, and company cost the signed sum of line totals', () => {
    fc.assert(
      fc.property(
        fc.array(line, { maxLength: 30 }),
        terms,
        (lines: CostLine[], t: EstimateTerms) => {
          const totals = estimateTotals(lines, t);
          const company = sum(
            lines
              .filter((l) => l.suppliedBy === 'company')
              .map((l) => (l.lineKind === 'salvage_credit' ? `-${lineTotal(l)}` : lineTotal(l))),
          );
          expect(totals.companyCost).toBe(company.toFixed(2));
          expect(totals.totalCost).toBe(
            sum([totals.companyCost, totals.overheadAmount, totals.contingencyAmount]).toFixed(2),
          );
          if (totals.proposedPrice !== null) {
            expect(totals.expectedMargin).toBe(
              new Decimal(totals.proposedPrice).minus(totals.totalCost).toFixed(2),
            );
          }
        },
      ),
    );
  });

  it('changing client-supplied lines never changes company cost, total cost or margin', () => {
    fc.assert(
      fc.property(
        fc.array(line, { maxLength: 20 }),
        fc.array(line, { maxLength: 20 }),
        terms,
        (lines: CostLine[], extra: CostLine[], t: EstimateTerms) => {
          const company = lines.filter((l) => l.suppliedBy === 'company');
          const client = extra.map((l): CostLine => ({ ...l, suppliedBy: 'client' }));
          const base = estimateTotals(company, t);
          const mixed = estimateTotals([...company, ...client], t);
          expect(mixed.companyCost).toBe(base.companyCost);
          expect(mixed.totalCost).toBe(base.totalCost);
          expect(mixed.expectedMargin).toBe(base.expectedMargin);
          expect(mixed.marginPercent).toBe(base.marginPercent);
        },
      ),
    );
  });

  it('line totals are never negative and have 2 decimals', () => {
    fc.assert(
      fc.property(quantity, rate, (q, r) => {
        const total = lineTotal({ quantity: q, rate: r });
        expect(total).toMatch(/^\d+\.\d{2}$/);
      }),
    );
  });
});

describe('formula invariants', () => {
  it('integer arithmetic on parameters agrees with exact integer math', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1000 }),
        (a, b, c) => {
          const values = { a: String(a), b: String(b), c: String(c) };
          expect(evaluateFormula('a * b + c', values)).toBe(
            String(BigInt(a) * BigInt(b) + BigInt(c)),
          );
          expect(evaluateFormula('ceil(a / c)', values)).toBe(String(Math.ceil(a / c)));
          expect(evaluateFormula('floor(a / c)', values)).toBe(String(Math.floor(a / c)));
        },
      ),
    );
  });
});
