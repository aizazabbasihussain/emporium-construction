import { describe, expect, it } from 'vitest';
import {
  aggregateTaxReport,
  assertValidRange,
  calculateSalesTax,
  calculateWithholding,
  inRange,
  planSuccession,
  rangesOverlap,
  resolveAuthority,
  selectRule,
  type RegionMapEntry,
  type SalesRuleRef,
  type TaxLineInput,
  type TaxRateRule,
} from './index.js';

// Every rate here is a synthetic test value; the engine itself ships with none (spec BR-9).
const ruleA: TaxRateRule = { id: 'ra', authorityCode: 'AUTH1', taxCode: 'ST', ratePercent: '10' };
const ruleB: TaxRateRule = { id: 'rb', authorityCode: 'AUTH1', taxCode: 'ST', ratePercent: '5' };
const ruleC: TaxRateRule = { id: 'rc', authorityCode: 'AUTH2', taxCode: 'PT', ratePercent: '10' };
const ruleA2: TaxRateRule = { id: 'ra2', authorityCode: 'AUTH1', taxCode: 'ST', ratePercent: '10' };

const line = (id: string, amount: string, rule: TaxRateRule): TaxLineInput => ({
  id,
  amount,
  rule,
});

describe('ranges', () => {
  it('tests whether a date is inside a range, open-ended or closed', () => {
    expect(inRange({ effectiveFrom: '2026-01-01', effectiveTo: null }, '2026-01-01')).toBe(true);
    expect(inRange({ effectiveFrom: '2026-01-01', effectiveTo: null }, '2025-12-31')).toBe(false);
    expect(inRange({ effectiveFrom: '2026-01-01', effectiveTo: '2026-01-31' }, '2026-01-31')).toBe(
      true,
    );
    expect(inRange({ effectiveFrom: '2026-01-01', effectiveTo: '2026-01-31' }, '2026-02-01')).toBe(
      false,
    );
  });

  it('detects overlap, including touching days and open ends', () => {
    const a = { effectiveFrom: '2026-01-01', effectiveTo: '2026-01-31' };
    expect(rangesOverlap(a, { effectiveFrom: '2026-01-31', effectiveTo: null })).toBe(true);
    expect(rangesOverlap(a, { effectiveFrom: '2026-02-01', effectiveTo: null })).toBe(false);
    expect(rangesOverlap({ effectiveFrom: '2026-03-01', effectiveTo: null }, a)).toBe(false);
  });

  it('validates a range', () => {
    expect(() =>
      assertValidRange({ effectiveFrom: '2026-01-01', effectiveTo: null }),
    ).not.toThrow();
    expect(() =>
      assertValidRange({ effectiveFrom: '2026-01-01', effectiveTo: '2026-01-01' }),
    ).not.toThrow();
    expect(() =>
      assertValidRange({ effectiveFrom: '2026-01-02', effectiveTo: '2026-01-01' }),
    ).toThrow('cannot end before');
    expect(() => assertValidRange({ effectiveFrom: '2026-13-01', effectiveTo: null })).toThrow();
    expect(() => assertValidRange({ effectiveFrom: '2026-01-01', effectiveTo: 'soon' })).toThrow();
  });

  it('closes an open-ended predecessor the day before an open-ended successor (BR-5)', () => {
    const existing = [{ id: 'old', effectiveFrom: '2026-01-01', effectiveTo: null }];
    expect(planSuccession({ effectiveFrom: '2026-07-01', effectiveTo: null }, existing)).toEqual([
      { id: 'old', effectiveTo: '2026-06-30' },
    ]);
    expect(planSuccession({ effectiveFrom: '2026-07-01', effectiveTo: null }, [])).toEqual([]);
  });

  it('rejects any other overlap (BR-2)', () => {
    const open = [{ id: 'old', effectiveFrom: '2026-01-01', effectiveTo: null }];
    const closed = [{ id: 'old', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }];
    // Same start, earlier start, bounded successor, and a closed predecessor.
    expect(() => planSuccession({ effectiveFrom: '2026-01-01', effectiveTo: null }, open)).toThrow(
      'overlap',
    );
    expect(() => planSuccession({ effectiveFrom: '2025-01-01', effectiveTo: null }, open)).toThrow(
      'overlap',
    );
    expect(() =>
      planSuccession({ effectiveFrom: '2026-07-01', effectiveTo: '2026-08-01' }, open),
    ).toThrow('overlap');
    expect(() =>
      planSuccession({ effectiveFrom: '2026-07-01', effectiveTo: null }, closed),
    ).toThrow('overlap');
    expect(planSuccession({ effectiveFrom: '2027-01-01', effectiveTo: null }, closed)).toEqual([]);
  });
});

describe('resolveAuthority (T-1)', () => {
  const entry = (
    id: string,
    region: string,
    supplyKind: string,
    authorityCode: string,
    effectiveFrom: string,
    effectiveTo: string | null,
  ): RegionMapEntry => ({ id, region, supplyKind, authorityCode, effectiveFrom, effectiveTo });
  const map = [
    entry('1', 'islamabad', 'services', 'AUTH1', '2026-01-01', null),
    entry('2', 'islamabad', 'goods', 'AUTH1', '2026-01-01', null),
    entry('3', 'punjab', 'services', 'AUTH2', '2026-01-01', '2026-06-30'),
    entry('4', 'punjab', 'services', 'AUTH1', '2026-07-01', null),
    entry('5', 'punjab', 'goods', 'AUTH1', '2026-01-01', null),
  ];
  const query = (region: string, supplyKind: string, date: string) => ({
    region,
    supplyKind,
    date,
  });

  it('resolves both regions and both supply kinds', () => {
    expect(resolveAuthority(map, query('islamabad', 'services', '2026-03-01'))).toBe('AUTH1');
    expect(resolveAuthority(map, query('islamabad', 'goods', '2026-03-01'))).toBe('AUTH1');
    expect(resolveAuthority(map, query('punjab', 'services', '2026-03-01'))).toBe('AUTH2');
    expect(resolveAuthority(map, query('punjab', 'goods', '2026-03-01'))).toBe('AUTH1');
  });

  it('follows a mapping change across dates', () => {
    expect(resolveAuthority(map, query('punjab', 'services', '2026-06-30'))).toBe('AUTH2');
    expect(resolveAuthority(map, query('punjab', 'services', '2026-07-01'))).toBe('AUTH1');
  });

  it('blocks when nothing is mapped, never silently untaxed', () => {
    expect(() => resolveAuthority(map, query('punjab', 'services', '2025-12-31'))).toThrow(
      'No tax authority is mapped for services in punjab on 2025-12-31',
    );
    expect(() => resolveAuthority([], query('islamabad', 'goods', '2026-03-01'))).toThrow(
      'No tax authority is mapped',
    );
  });

  it('blocks when two mappings apply', () => {
    const twice = [...map, entry('6', 'islamabad', 'goods', 'AUTH2', '2026-01-01', null)];
    expect(() => resolveAuthority(twice, query('islamabad', 'goods', '2026-03-01'))).toThrow(
      'More than one tax authority',
    );
  });
});

describe('selectRule (T-2)', () => {
  const rule = (
    id: string,
    nature: string | null,
    from: string,
    to: string | null,
    authorityCode = 'AUTH1',
    supplyKind = 'services',
  ): SalesRuleRef => ({
    id,
    authorityCode,
    supplyKind,
    nature,
    taxCode: 'ST',
    ratePercent: '10',
    effectiveFrom: from,
    effectiveTo: to,
  });
  const rules = [
    rule('general', null, '2026-01-01', null),
    rule('civil', 'civil', '2026-01-01', null),
    rule('old-fit', 'fitout', '2026-01-01', '2026-03-31'),
    rule('new-fit', 'fitout', '2026-04-01', null),
    rule('goods', null, '2026-01-01', null, 'AUTH1', 'goods'),
    rule('other-auth', null, '2026-01-01', null, 'AUTH2'),
  ];
  const pick = (nature: string | null, date: string, authorityCode = 'AUTH1') =>
    selectRule(rules, { authorityCode, supplyKind: 'services', nature, date }).id;

  it('prefers the rule for the nature and falls back to the rule without one', () => {
    expect(pick('civil', '2026-02-01')).toBe('civil');
    expect(pick('plumbing', '2026-02-01')).toBe('general');
    expect(pick(null, '2026-02-01')).toBe('general');
  });

  it('selects by date and by authority and supply kind', () => {
    expect(pick('fitout', '2026-03-31')).toBe('old-fit');
    expect(pick('fitout', '2026-04-01')).toBe('new-fit');
    expect(pick(null, '2026-02-01', 'AUTH2')).toBe('other-auth');
    expect(
      selectRule(rules, {
        authorityCode: 'AUTH1',
        supplyKind: 'goods',
        nature: null,
        date: '2026-02-01',
      }).id,
    ).toBe('goods');
  });

  it('fails with a message that names the missing rule when nothing matches (BR-9)', () => {
    expect(() => pick(null, '2025-12-31')).toThrow(
      'No active sales tax rule for AUTH1 services on 2025-12-31',
    );
    expect(() => pick('civil', '2025-12-31')).toThrow('AUTH1 services (civil) on 2025-12-31');
    expect(() => pick(null, '2026-02-01', 'NOBODY')).toThrow('NOBODY services');
  });

  it('fails when several rules match', () => {
    const doubled = [...rules, rule('civil-2', 'civil', '2026-02-01', null)];
    expect(() =>
      selectRule(doubled, {
        authorityCode: 'AUTH1',
        supplyKind: 'services',
        nature: 'civil',
        date: '2026-03-01',
      }),
    ).toThrow('More than one sales tax rule');
  });
});

describe('calculateSalesTax (T-3)', () => {
  const exclusive = { pricesIncludeTax: false } as const;
  const inclusive = { pricesIncludeTax: true } as const;

  it('adds tax to exclusive prices', () => {
    const result = calculateSalesTax([line('1', '1000.00', ruleA)], {
      ...exclusive,
      roundingMode: 'per_document',
    });
    expect(result).toMatchObject({
      base: '1000.00',
      taxTotal: '100.00',
      total: '1100.00',
      roundingMode: 'per_document',
      pricesIncludeTax: false,
    });
    expect(result.taxLines).toEqual([
      {
        authorityCode: 'AUTH1',
        taxCode: 'ST',
        ratePercent: '10.0000',
        ruleIds: ['ra'],
        base: '1000.00',
        tax: '100.00',
      },
    ]);
    expect(result.lines).toEqual([{ id: '1', ruleId: 'ra', base: null, tax: null }]);
  });

  it('splits inclusive prices into base and tax', () => {
    const result = calculateSalesTax([line('1', '1100.00', ruleA)], {
      ...inclusive,
      roundingMode: 'per_document',
    });
    expect(result).toMatchObject({ base: '1000.00', taxTotal: '100.00', total: '1100.00' });
  });

  it('handles several rates and authorities on one document', () => {
    const result = calculateSalesTax(
      [line('1', '200.00', ruleA), line('2', '100.00', ruleB), line('3', '50.00', ruleC)],
      { ...exclusive, roundingMode: 'per_document' },
    );
    expect(
      result.taxLines.map((group) => [group.authorityCode, group.ratePercent, group.tax]),
    ).toEqual([
      ['AUTH1', '10.0000', '20.00'],
      ['AUTH1', '5.0000', '5.00'],
      ['AUTH2', '10.0000', '5.00'],
    ]);
    expect(result).toMatchObject({ base: '350.00', taxTotal: '30.00', total: '380.00' });
  });

  it('groups lines of different rules that share authority, rate and tax code', () => {
    const result = calculateSalesTax([line('1', '100.00', ruleA), line('2', '100.00', ruleA2)], {
      ...exclusive,
      roundingMode: 'per_document',
    });
    expect(result.taxLines).toHaveLength(1);
    expect(result.taxLines[0]?.ruleIds).toEqual(['ra', 'ra2']);
    expect(result.taxTotal).toBe('20.00');
  });

  it('shows the difference between per-line and per-document rounding on a crafted example', () => {
    const lines = [line('1', '0.05', ruleA), line('2', '0.05', ruleA), line('3', '0.05', ruleA)];
    const perLine = calculateSalesTax(lines, { ...exclusive, roundingMode: 'per_line' });
    const perDocument = calculateSalesTax(lines, { ...exclusive, roundingMode: 'per_document' });
    // 0.005 rounds up to 0.01 on each line (0.03), but 0.015 rounds to 0.02 on the sum.
    expect(perLine.taxTotal).toBe('0.03');
    expect(perDocument.taxTotal).toBe('0.02');
    expect(perLine.lines.map((l) => l.tax)).toEqual(['0.01', '0.01', '0.01']);
    expect(perLine.lines.map((l) => l.base)).toEqual(['0.05', '0.05', '0.05']);
    expect(perLine.total).toBe('0.18');
    expect(perDocument.total).toBe('0.17');
  });

  it('rounds inclusive prices per line and per document, keeping the gross exact', () => {
    const lines = [line('1', '0.10', ruleA), line('2', '0.10', ruleA), line('3', '0.10', ruleA)];
    const perLine = calculateSalesTax(lines, { ...inclusive, roundingMode: 'per_line' });
    const perDocument = calculateSalesTax(lines, { ...inclusive, roundingMode: 'per_document' });
    expect(perLine.total).toBe('0.30');
    expect(perDocument.total).toBe('0.30');
    expect(perLine.lines.map((l) => [l.base, l.tax])).toEqual([
      ['0.09', '0.01'],
      ['0.09', '0.01'],
      ['0.09', '0.01'],
    ]);
    expect(perDocument).toMatchObject({ base: '0.27', taxTotal: '0.03' });
  });

  it('allows a zero rate and an empty document', () => {
    const zero: TaxRateRule = { ...ruleA, id: 'rz', ratePercent: '0' };
    expect(
      calculateSalesTax([line('1', '100.00', zero)], { ...exclusive, roundingMode: 'per_line' }),
    ).toMatchObject({ taxTotal: '0.00', total: '100.00' });
    expect(calculateSalesTax([], { ...exclusive, roundingMode: 'per_document' })).toMatchObject({
      base: '0.00',
      total: '0.00',
      taxLines: [],
    });
  });

  it('rounds half-up and treats credit amounts symmetrically', () => {
    expect(
      calculateSalesTax([line('1', '-0.05', ruleA)], { ...exclusive, roundingMode: 'per_line' })
        .taxTotal,
    ).toBe('-0.01');
  });
});

describe('calculateWithholding (T-4)', () => {
  const bases = { invoiceTotal: '1100.00', taxAmount: '100.00', base: '1000.00' };

  it('applies the rate to each kind of base', () => {
    expect(
      calculateWithholding({ id: 'w1', ratePercent: '10', base: 'on_invoice_total' }, bases),
    ).toEqual({
      ruleId: 'w1',
      basis: 'on_invoice_total',
      ratePercent: '10.0000',
      baseAmount: '1100.00',
      amount: '110.00',
    });
    expect(
      calculateWithholding({ id: 'w2', ratePercent: '50', base: 'on_tax_amount' }, bases).amount,
    ).toBe('50.00');
    expect(
      calculateWithholding({ id: 'w3', ratePercent: '2.5', base: 'on_base' }, bases).amount,
    ).toBe('25.00');
  });

  it('allows a zero rate and rounds half-up', () => {
    expect(
      calculateWithholding({ id: 'w4', ratePercent: '0', base: 'on_base' }, bases).amount,
    ).toBe('0.00');
    expect(
      calculateWithholding(
        { id: 'w5', ratePercent: '10', base: 'on_base' },
        { invoiceTotal: '0', taxAmount: '0', base: '0.05' },
      ).amount,
    ).toBe('0.01');
  });
});

describe('aggregateTaxReport (T-7)', () => {
  it('nets credit notes from output tax and keeps input and withholding apart', () => {
    const report = aggregateTaxReport([
      { documentId: 'i1', kind: 'invoice', date: '2026-10-02', base: '1000.00', tax: '100.00' },
      { documentId: 'i2', kind: 'invoice', date: '2026-10-09', base: '500.00', tax: '50.00' },
      { documentId: 'c1', kind: 'credit_note', date: '2026-10-12', base: '200.00', tax: '20.00' },
      { documentId: 'b1', kind: 'vendor_bill', date: '2026-10-15', base: '300.00', tax: '30.00' },
      {
        documentId: 'w1',
        kind: 'withholding_deducted',
        date: '2026-10-16',
        base: '300.00',
        tax: '6.00',
      },
      {
        documentId: 'w2',
        kind: 'withholding_suffered',
        date: '2026-10-17',
        base: '1100.00',
        tax: '11.00',
      },
    ]);
    expect(report).toEqual({
      outputTax: { base: '1300.00', tax: '130.00', documents: 3 },
      inputTax: { base: '300.00', tax: '30.00', documents: 1 },
      withholdingDeducted: { base: '300.00', tax: '6.00', documents: 1 },
      withholdingSuffered: { base: '1100.00', tax: '11.00', documents: 1 },
    });
  });

  it('reports zero for an empty period', () => {
    expect(aggregateTaxReport([]).outputTax).toEqual({ base: '0.00', tax: '0.00', documents: 0 });
  });
});
