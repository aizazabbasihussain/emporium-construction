import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  columnTotals,
  controlMismatches,
  dataSection,
  layoutOf,
  planTags,
  lineKey,
  type ExportRow,
  type MappingRule,
  type TaggableLine,
} from '../src/accounting/index.js';

const cents = fc.integer({ min: -100_000_000, max: 100_000_000 });
const money = (n: number): string => (n / 100).toFixed(2);
const layout = layoutOf('receipts_register');

const rows = (amounts: number[]): ExportRow[] =>
  amounts.map((n, i) => ({
    values: { date: '2026-10-01', number: `RV-${i}`, amount: money(n), withheld: '0.00' },
  }));

describe('exported sums equal the owning total (T-8)', () => {
  it('the sum of the exported rows equals the total worked out in cents, in any order', () => {
    fc.assert(
      fc.property(fc.array(cents, { maxLength: 40 }), (amounts) => {
        const total = amounts.reduce((a, b) => a + b, 0);
        const exported = columnTotals(layout, rows(amounts));
        expect(exported.amount).toBe(money(total));
        const reversed = columnTotals(layout, rows([...amounts].reverse()));
        expect(reversed.amount).toBe(exported.amount);
        expect(
          controlMismatches(layout, exported, { amount: money(total), withheld: '0.00' }),
        ).toEqual([]);
        expect(
          controlMismatches(layout, exported, { amount: money(total + 1), withheld: '0.00' }),
        ).toHaveLength(1);
      }),
    );
  });

  it('the data section is the same for the same rows (T-5)', () => {
    fc.assert(
      fc.property(fc.array(cents, { maxLength: 20 }), (amounts) => {
        expect(dataSection(layout, rows(amounts))).toBe(dataSection(layout, rows(amounts)));
      }),
    );
  });
});

describe('tagging never changes a tagged line (T-3)', () => {
  it('plans nothing for lines that already carry a tag, whatever the rules say', () => {
    const rule = (id: string, credit: string): MappingRule => ({
      id,
      sourceDocType: 'invoice',
      condition: {},
      debitAccountCode: '1210',
      creditAccountCode: credit,
      effectiveFrom: '2026-01-01',
      active: true,
    });
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 30 }), { maxLength: 20 }),
        fc.array(fc.nat({ max: 30 }), { maxLength: 20 }),
        (ids, taggedIds) => {
          const lines: TaggableLine[] = [...new Set(ids)].map((n) => ({
            docType: 'invoice',
            docId: `d${n}`,
            lineRef: '',
            date: '2026-10-01',
            attrs: {},
          }));
          const tagged = new Set(
            taggedIds.map((n) => lineKey({ docType: 'invoice', docId: `d${n}`, lineRef: '' })),
          );
          const plan = planTags(lines, tagged, [rule('a', '4100'), rule('b', '4110')]);
          for (const proposal of plan.proposals)
            expect(tagged.has(lineKey(proposal.line))).toBe(false);
          expect(plan.proposals.length + plan.unmatched.length + plan.alreadyTagged).toBe(
            lines.length,
          );
        },
      ),
    );
  });
});
