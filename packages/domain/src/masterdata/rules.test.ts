import { describe, expect, it } from 'vitest';
import {
  assertConversionPair,
  assertNoCycle,
  assertNoRegistrationOverlap,
  assertStockableRule,
  assertValidRange,
  canDeactivateCostCode,
  convertQuantity,
  findDuplicates,
  isHardDuplicate,
  isInForce,
  normalizeAuthority,
  normalizeCnic,
  normalizeName,
  normalizePhone,
  normalizeTaxNumber,
  rangesOverlap,
  seriesForRole,
  wouldCreateCycle,
} from './rules.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('normalizeCnic (T-2)', () => {
  it('accepts 13 digits with or without hyphens and spaces', () => {
    expect(normalizeCnic('3520212345671')).toBe('3520212345671');
    expect(normalizeCnic('35202-1234567-1')).toBe('3520212345671');
    expect(normalizeCnic(' 35202 1234567 1 ')).toBe('3520212345671');
  });

  it.each(['352021234567', '35202123456712', '35202-1234567-A', '', 'abcdefghijklm'])(
    'rejects %j',
    (value) => {
      expect(codeOf(() => normalizeCnic(value))).toBe('invalid_cnic');
    },
  );
});

describe('normalizePhone (T-2)', () => {
  it.each([
    ['0300 1234567', '+923001234567'],
    ['0300-1234567', '+923001234567'],
    ['+92 300 1234567', '+923001234567'],
    ['+92(300)1234567', '+923001234567'],
    ['923001234567', '+923001234567'],
    ['00923001234567', '+923001234567'],
    ['051-1234567', '+92511234567'],
    ['0511.234567', '+92511234567'],
  ])('normalizes %j', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([
    ['too short', '0300123'],
    ['too long', '030012345678901'],
    ['letters', '0300ABC4567'],
    ['empty', ''],
    ['other country code', '+14155550123'],
    ['no prefix', '3001234567'],
    ['short 92 prefix', '92300123'],
    ['trunk only', '0'],
    ['zero after the country code', '+920300123456'],
  ])('rejects %s', (_label, raw) => {
    expect(codeOf(() => normalizePhone(raw))).toBe('invalid_phone');
  });
});

describe('normalizeTaxNumber and normalizeName', () => {
  it('removes separators and upper-cases', () => {
    expect(normalizeTaxNumber('1234567-8')).toBe('12345678');
    expect(normalizeTaxNumber(' ab 123 ')).toBe('AB123');
  });

  it.each(['12', 'a'.repeat(21), '12/34', ''])('rejects the tax number %j', (value) => {
    expect(codeOf(() => normalizeTaxNumber(value))).toBe('invalid_tax_number');
  });

  it('compares names ignoring case and repeated spaces', () => {
    expect(normalizeName('  Al   Noor  Traders ')).toBe('al noor traders');
  });
});

describe('findDuplicates (T-1)', () => {
  const existing = [
    { id: 'a', name: 'Al Noor Traders', phone: '+923001234567', ntn: '1111111', cnic: null },
    { id: 'b', name: 'Bashir', phone: null, ntn: '2222222', cnic: '3520212345671' },
    { id: 'c', name: 'Chaudhry', phone: '+923009999999', ntn: null, cnic: null },
  ];
  const candidate = {
    name: 'Someone',
    phone: null as string | null,
    ntn: null as string | null,
    cnic: null as string | null,
  };

  it('matches the same name and phone', () => {
    const found = findDuplicates(
      { ...candidate, name: ' AL  noor traders', phone: '+923001234567' },
      existing,
    );
    expect(found).toEqual([{ id: 'a', reason: 'name_phone' }]);
    expect(isHardDuplicate(found[0] as never)).toBe(false);
  });

  it('does not match the same phone under another name, or the same name without a phone', () => {
    expect(
      findDuplicates({ ...candidate, name: 'Other', phone: '+923001234567' }, existing),
    ).toEqual([]);
    expect(findDuplicates({ ...candidate, name: 'Al Noor Traders' }, existing)).toEqual([]);
  });

  it('matches the same NTN or CNIC as a hard duplicate', () => {
    const byNtn = findDuplicates({ ...candidate, ntn: '1111111' }, existing);
    expect(byNtn).toEqual([{ id: 'a', reason: 'ntn' }]);
    expect(isHardDuplicate(byNtn[0] as never)).toBe(true);
    const byCnic = findDuplicates(
      { ...candidate, cnic: '3520212345671', ntn: '2222222' },
      existing,
    );
    expect(byCnic).toEqual([{ id: 'b', reason: 'cnic' }]);
  });

  it('never matches itself and ignores missing fields', () => {
    expect(findDuplicates({ ...candidate, id: 'a', ntn: '1111111' }, existing)).toEqual([]);
    expect(findDuplicates(candidate, existing)).toEqual([]);
  });
});

describe('assertStockableRule (T-3)', () => {
  it.each(['material', 'consumable'])('allows a stockable %s item', (kind) => {
    expect(() => assertStockableRule(kind, true)).not.toThrow();
    expect(() => assertStockableRule(kind, false)).not.toThrow();
  });

  it.each(['service', 'labour', 'equipment'])('rejects a stockable %s item', (kind) => {
    expect(codeOf(() => assertStockableRule(kind, true))).toBe('item_not_stockable');
    expect(() => assertStockableRule(kind, false)).not.toThrow();
  });
});

describe('convertQuantity (T-4)', () => {
  const pairs = [{ fromUnit: 'ton', toUnit: 'kg', factor: '1000' }];

  it('converts with the direct pair and with its inverse', () => {
    expect(convertQuantity('2.5', 'ton', 'kg', pairs)).toBe('2500.0000');
    expect(convertQuantity('2500', 'kg', 'ton', pairs)).toBe('2.5000');
  });

  it('returns the same quantity for the same unit, rounded to 4 decimals half-up', () => {
    expect(convertQuantity('1.23455', 'kg', 'kg', pairs)).toBe('1.2346');
    expect(convertQuantity('1.23454', 'kg', 'kg', pairs)).toBe('1.2345');
  });

  it('rounds half-up at 4 decimals', () => {
    expect(convertQuantity('1', 'kg', 'ton', pairs)).toBe('0.0010');
    expect(
      convertQuantity('0.00005', 'ton', 'kg', [{ fromUnit: 'ton', toUnit: 'kg', factor: '1' }]),
    ).toBe('0.0001');
  });

  it('fails for a missing pair and does not chain', () => {
    expect(codeOf(() => convertQuantity('1', 'kg', 'm', pairs))).toBe('conversion_missing');
    const chain = [...pairs, { fromUnit: 'kg', toUnit: 'g', factor: '1000' }];
    expect(codeOf(() => convertQuantity('1', 'ton', 'g', chain))).toBe('conversion_missing');
  });
});

describe('assertConversionPair', () => {
  it('accepts a positive factor with up to 6 decimals', () => {
    expect(() =>
      assertConversionPair({ fromUnit: 'ft', toUnit: 'm', factor: '0.304800' }),
    ).not.toThrow();
  });

  it.each([
    ['same unit', { fromUnit: 'm', toUnit: 'm', factor: '1' }, 'conversion_same_unit'],
    ['zero', { fromUnit: 'ft', toUnit: 'm', factor: '0' }, 'conversion_factor_invalid'],
    ['negative', { fromUnit: 'ft', toUnit: 'm', factor: '-1' }, 'conversion_factor_invalid'],
    [
      '7 decimals',
      { fromUnit: 'ft', toUnit: 'm', factor: '0.1234567' },
      'conversion_factor_invalid',
    ],
    [
      'too large',
      { fromUnit: 'ft', toUnit: 'm', factor: '1000000000000' },
      'conversion_factor_invalid',
    ],
  ])('rejects %s', (_label, pair, code) => {
    expect(codeOf(() => assertConversionPair(pair))).toBe(code);
  });
});

describe('hierarchy cycles (T-5)', () => {
  const parents = new Map<string, string | null>([
    ['root', null],
    ['a', 'root'],
    ['b', 'a'],
    ['x', 'y'],
    ['y', 'x'],
  ]);

  it('allows a new parent that is not below the node', () => {
    expect(wouldCreateCycle('b', 'root', parents)).toBe(false);
    expect(wouldCreateCycle('b', null, parents)).toBe(false);
    expect(wouldCreateCycle('new', 'b', parents)).toBe(false);
  });

  it('detects the node as its own parent or a descendant as parent', () => {
    expect(wouldCreateCycle('a', 'a', parents)).toBe(true);
    expect(wouldCreateCycle('root', 'b', parents)).toBe(true);
    expect(codeOf(() => assertNoCycle('root', 'b', parents))).toBe('hierarchy_cycle');
    expect(() => assertNoCycle('b', 'root', parents)).not.toThrow();
  });

  it('stops on an existing loop that does not include the node', () => {
    expect(wouldCreateCycle('z', 'x', parents)).toBe(false);
  });
});

describe('canDeactivateCostCode (T-5)', () => {
  it.each([
    [{ postedCosts: false, openBudgetLines: false }, true],
    [{ postedCosts: false, openBudgetLines: true }, true],
    [{ postedCosts: true, openBudgetLines: false }, true],
    [{ postedCosts: true, openBudgetLines: true }, false],
  ])('%j gives %s', (usage, expected) => {
    expect(canDeactivateCostCode(usage)).toBe(expected);
  });
});

describe('date ranges and registrations (T-6)', () => {
  const range = (validFrom: string, validTo: string | null) => ({ validFrom, validTo });

  it('detects overlap, including open ends and shared boundary days', () => {
    expect(rangesOverlap(range('2026-01-01', '2026-06-30'), range('2026-07-01', null))).toBe(false);
    expect(rangesOverlap(range('2026-07-01', null), range('2026-01-01', '2026-06-30'))).toBe(false);
    expect(rangesOverlap(range('2026-01-01', '2026-07-01'), range('2026-07-01', null))).toBe(true);
    expect(rangesOverlap(range('2026-01-01', null), range('2030-01-01', null))).toBe(true);
    expect(
      rangesOverlap(range('2026-01-01', '2026-12-31'), range('2026-03-01', '2026-04-01')),
    ).toBe(true);
  });

  it('validates a range', () => {
    expect(() => assertValidRange(range('2026-01-01', null))).not.toThrow();
    expect(() => assertValidRange(range('2026-01-01', '2026-01-01'))).not.toThrow();
    expect(codeOf(() => assertValidRange(range('2026-02-01', '2026-01-01')))).toBe(
      'invalid_date_range',
    );
  });

  it('rejects an overlap with another registration but ignores the registration itself', () => {
    const others = [{ id: 'r1', ...range('2026-01-01', '2026-06-30') }];
    expect(codeOf(() => assertNoRegistrationOverlap(range('2026-06-01', null), others))).toBe(
      'registration_overlap',
    );
    expect(() => assertNoRegistrationOverlap(range('2026-07-01', null), others)).not.toThrow();
    expect(() =>
      assertNoRegistrationOverlap({ id: 'r1', ...range('2026-03-01', null) }, others),
    ).not.toThrow();
  });

  it('knows whether a date is inside a range', () => {
    expect(isInForce(range('2026-01-01', '2026-12-31'), '2026-01-01')).toBe(true);
    expect(isInForce(range('2026-01-01', '2026-12-31'), '2026-12-31')).toBe(true);
    expect(isInForce(range('2026-01-01', '2026-12-31'), '2027-01-01')).toBe(false);
    expect(isInForce(range('2026-01-01', null), '2090-01-01')).toBe(true);
    expect(isInForce(range('2026-01-01', null), '2025-12-31')).toBe(false);
  });
});

describe('authority codes and series', () => {
  it('upper-cases an authority code', () => {
    expect(normalizeAuthority(' fbr ')).toBe('FBR');
    expect(normalizeAuthority('pra_2')).toBe('PRA_2');
  });

  it.each(['', 'F', '1ab', 'has space', 'a'.repeat(21)])('rejects the authority %j', (value) => {
    expect(codeOf(() => normalizeAuthority(value))).toBe('invalid_authority');
  });

  it('names the party number series after the role', () => {
    expect(seriesForRole('vendor')).toBe('party_vendor');
  });
});
