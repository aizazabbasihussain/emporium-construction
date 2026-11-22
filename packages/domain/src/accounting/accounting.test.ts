import { describe, expect, it } from 'vitest';
import {
  columnTotals,
  controlMismatches,
  dataSection,
  exportCodeList,
  exportLayouts,
  findLayout,
  fiscalLabel,
  fiscalRange,
  fiscalStartYear,
  layoutOf,
  lineKey,
  monthOf,
  pickRule,
  planTags,
  ruleApplies,
  tagAccountOf,
  tagSide,
  untaggedCount,
  type ExportRow,
  type MappingRule,
  type TaggableLine,
} from './index.js';

const rule = (over: Partial<MappingRule> = {}): MappingRule => ({
  id: 'r1',
  sourceDocType: 'invoice',
  condition: {},
  debitAccountCode: '1210',
  creditAccountCode: '4100',
  effectiveFrom: '2026-07-01',
  active: true,
  ...over,
});
const line = (over: Partial<TaggableLine> = {}): TaggableLine => ({
  docType: 'invoice',
  docId: 'd1',
  lineRef: '',
  date: '2026-10-01',
  attrs: {},
  ...over,
});

describe('fiscal year labels (T-6, BR-7)', () => {
  it('labels a July start across the year end', () => {
    expect(fiscalLabel('2026-06-30', 7)).toBe('FY2025-26');
    expect(fiscalLabel('2026-07-01', 7)).toBe('FY2026-27');
    expect(fiscalLabel('2026-12-31', 7)).toBe('FY2026-27');
    expect(fiscalLabel('2027-06-30', 7)).toBe('FY2026-27');
    expect(fiscalLabel('2099-08-01', 7)).toBe('FY2099-00');
  });

  it('labels a January start as the calendar year', () => {
    expect(fiscalLabel('2026-01-01', 1)).toBe('FY2026');
    expect(fiscalLabel('2026-12-31', 1)).toBe('FY2026');
    expect(fiscalStartYear('2026-03-05', 1)).toBe(2026);
  });

  it('gives the first and last day of a fiscal year', () => {
    expect(fiscalRange(2026, 7)).toEqual({ from: '2026-07-01', to: '2027-06-30' });
    expect(fiscalRange(2027, 3)).toEqual({ from: '2027-03-01', to: '2028-02-29' });
    expect(fiscalRange(2026, 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('refuses a start month outside 1 to 12 and a bad date', () => {
    expect(() => fiscalLabel('2026-10-01', 0)).toThrow('The fiscal year starts');
    expect(() => fiscalLabel('2026-10-01', 13)).toThrow('The fiscal year starts');
    expect(() => fiscalLabel('2026-10-01', 7.5)).toThrow('The fiscal year starts');
    expect(() => fiscalRange(2026, 0)).toThrow('The fiscal year starts');
    expect(() => monthOf('26-10-01')).toThrow('Not a date');
    expect(() => monthOf('2026-13-01')).toThrow('Not a date');
    expect(() => monthOf('2026-00-01')).toThrow('Not a date');
  });

  it('names the month of a date', () => {
    expect(monthOf('2026-10-25')).toBe('2026-10');
  });
});

describe('mapping rules (T-3, BR-1)', () => {
  it('applies only an active rule of the type, in force, whose attributes all fit', () => {
    expect(ruleApplies(rule(), line())).toBe(true);
    expect(ruleApplies(rule({ active: false }), line())).toBe(false);
    expect(ruleApplies(rule({ sourceDocType: 'bill' }), line())).toBe(false);
    expect(ruleApplies(rule({ effectiveFrom: '2026-10-02' }), line())).toBe(false);
    expect(ruleApplies(rule({ condition: { kind: 'advance' } }), line())).toBe(false);
    expect(
      ruleApplies(rule({ condition: { kind: 'advance' } }), line({ attrs: { kind: 'advance' } })),
    ).toBe(true);
  });

  it('prefers the rule naming more attributes, then the later date, then the smaller id', () => {
    const plain = rule({ id: 'a' });
    const specific = rule({ id: 'b', condition: { kind: 'advance' } });
    const target = line({ attrs: { kind: 'advance' } });
    expect(pickRule([plain, specific], target)?.id).toBe('b');
    expect(pickRule([specific, plain], target)?.id).toBe('b');
    const older = rule({ id: 'c', effectiveFrom: '2026-07-01' });
    const newer = rule({ id: 'd', effectiveFrom: '2026-09-01' });
    expect(pickRule([older, newer], line())?.id).toBe('d');
    expect(pickRule([newer, older], line())?.id).toBe('d');
    const first = rule({ id: 'e' });
    const second = rule({ id: 'f' });
    expect(pickRule([second, first], line())?.id).toBe('e');
    expect(pickRule([first, second], line())?.id).toBe('e');
    expect(pickRule([], line())).toBeUndefined();
  });

  it('tags the account the document is about, not the cash side', () => {
    const r = rule();
    expect(tagSide(line())).toBe('credit');
    expect(tagSide(line({ docType: 'receipt' }))).toBe('credit');
    expect(tagSide(line({ docType: 'credit_note' }))).toBe('debit');
    expect(tagSide(line({ docType: 'bill' }))).toBe('debit');
    expect(tagSide(line({ docType: 'cash_transaction', attrs: { direction: 'in' } }))).toBe(
      'credit',
    );
    expect(tagSide(line({ docType: 'cash_transaction', attrs: { direction: 'out' } }))).toBe(
      'debit',
    );
    expect(tagSide(line({ docType: 'stock_movement', attrs: { direction: 'issue' } }))).toBe(
      'credit',
    );
    expect(tagSide(line({ docType: 'stock_movement', attrs: { direction: 'receipt' } }))).toBe(
      'debit',
    );
    expect(tagAccountOf(r, line())).toBe('4100');
    expect(tagAccountOf(r, line({ docType: 'bill' }))).toBe('1210');
  });

  it('plans tags for untagged lines only and never retags a tagged one', () => {
    const lines = [
      line({ docId: 'a' }),
      line({ docId: 'b' }),
      line({ docId: 'c', docType: 'bill' }),
    ];
    const tagged = new Set([lineKey(lines[0] as TaggableLine)]);
    const plan = planTags(lines, tagged, [rule({ creditAccountCode: '4110' })]);
    expect(plan.alreadyTagged).toBe(1);
    expect(plan.proposals.map((p) => [p.line.docId, p.accountCode, p.ruleId])).toEqual([
      ['b', '4110', 'r1'],
    ]);
    expect(plan.unmatched.map((l) => l.docId)).toEqual(['c']);
  });
});

describe('export data (T-4, T-5, BR-4 to BR-6)', () => {
  const layout = layoutOf('receipts_register');
  const row = (over: Record<string, string | number | null>, tag = true): ExportRow => ({
    values: { date: '2026-10-01', number: 'RV-1', amount: '100.00', withheld: '0.00', ...over },
    tag: tag ? { docType: 'receipt', docId: 'x', lineRef: '' } : undefined,
  });

  it('sums every money column, counting a missing value as zero', () => {
    const totals = columnTotals(layout, [row({}), row({ amount: '250.50', withheld: null })]);
    expect(totals).toEqual({ amount: '350.50', withheld: '0.00' });
  });

  it('lists the control columns whose sum differs from the owning figure', () => {
    const totals = { amount: '350.50', withheld: '0.00' };
    expect(controlMismatches(layout, totals, { amount: '350.50', withheld: '0' })).toEqual([]);
    expect(controlMismatches(layout, totals, { amount: '350.00', withheld: '0.00' })).toEqual([
      { column: 'amount', exported: '350.50', owning: '350.00' },
    ]);
    expect(() => controlMismatches(layout, totals, { amount: '350.50' })).toThrow(
      'No control figure',
    );
  });

  it('counts the document rows without an account code', () => {
    const rows = [
      row({ account_code: '1210' }),
      row({}),
      row({ account_code: '' }),
      row({}, false),
    ];
    expect(untaggedCount(rows)).toBe(2);
  });

  it('writes the data section without any time or user, quoting where needed', () => {
    const text = dataSection(layout, [
      row({ number: 'a,"b"', method: null, account_code: '1210' }),
    ]);
    const [head, body] = text.split('\r\n');
    expect(head).toBe(layout.columns.map((c) => c.key).join(','));
    expect(body?.split(',').slice(0, 4)).toEqual(['', '', '2026-10-01', '"a']);
    expect(body).toContain('"a,""b"""');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(dataSection(layout, [row({})])).toBe(dataSection(layout, [row({})]));
  });
});

describe('layouts (BR-3, BR-10)', () => {
  it('has a version-1 layout for every export code, tagged in the last column', () => {
    expect(exportLayouts.map((l) => l.code).sort()).toEqual([...exportCodeList].sort());
    for (const l of exportLayouts) {
      expect(l.version).toBe(1);
      expect(l.columns.at(-1)?.key).toBe('account_code');
      const keys = l.columns.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const control of l.controlColumns) {
        expect(l.columns.find((c) => c.key === control)?.type).toBe('money');
      }
    }
  });

  it('finds a version or the latest, and refuses an unknown export', () => {
    expect(layoutOf('aging').code).toBe('aging');
    expect(layoutOf('aging', 1).version).toBe(1);
    expect(() => layoutOf('aging', 2)).toThrow('No export aging version 2');
    expect(() => layoutOf('trial_balance')).toThrow('No export trial_balance');
  });

  it('keeps an old version reproducible after a new one is issued (BR-10)', () => {
    const v1 = layoutOf('aging');
    const v2 = { ...v1, version: 2, columns: v1.columns.slice(0, 3) };
    const other = { ...layoutOf('sales_register'), version: 5 };
    const versions = [v2, other, v1];
    expect(findLayout(versions, 'aging')).toBe(v2);
    expect(findLayout(versions, 'aging', 1)).toBe(v1);
    expect(findLayout([v1, v2], 'aging')).toBe(v2);
    expect(findLayout(versions, 'sales_register').version).toBe(5);
    expect(() => findLayout(versions, 'aging', 3)).toThrow('No export aging version 3');
  });

  it('has no balance, trial balance or statement export (AC-3)', () => {
    for (const code of exportCodeList) expect(code).not.toMatch(/trial|balance_sheet|statement_of/);
  });
});
