import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  checkParameterValues,
  defaultRate,
  evaluateQuantity,
  instantiateLines,
  normalizeDecimal,
  type TemplateLineSource,
} from './instantiate.js';

const parameters = [
  { key: 'length', label: 'Length', unit: 'ft' },
  { key: 'height', label: 'Height', unit: 'ft' },
];

const source = (lineNo: number, qtyFormula: string, unitCode: string): TemplateLineSource => ({
  lineNo,
  description: `line ${lineNo}`,
  lineKind: 'material',
  itemId: null,
  costCodeId: 'cc',
  unitCode,
  qtyFormula,
  defaultRate: '5.0000',
  suppliedBy: 'company',
});

// A synthetic boundary wall: 13.5 bricks and 0.2 bags of cement per sqft, one labour day per 50 sqft.
const wall = [
  source(1, 'ceil(length * height * 13.5)', 'nos'),
  source(2, 'ceil(length * height * 0.2)', 'bag'),
  source(3, 'ceil(length * height / 50)', 'day'),
];

describe('instantiation from a boundary-wall template (spec P1-07 T-2, AC-1)', () => {
  const quantities = (length: string, height: string) =>
    instantiateLines(wall, parameters, { length, height }).map((line) => line.quantity);

  it('matches the hand-calculated quantities for several parameter sets', () => {
    expect(quantities('100', '6')).toEqual(['8100.0000', '120.0000', '12.0000']);
    expect(quantities('33.5', '5.5')).toEqual(['2488.0000', '37.0000', '4.0000']);
    expect(quantities('10', '10')).toEqual(['1350.0000', '20.0000', '2.0000']);
    expect(quantities('0', '8')).toEqual(['0.0000', '0.0000', '0.0000']);
  });

  it('keeps the line data and drops the formula and default rate', () => {
    const [first] = instantiateLines(wall, parameters, { length: '1', height: '1' });
    expect(first).toEqual({
      lineNo: 1,
      description: 'line 1',
      lineKind: 'material',
      itemId: null,
      costCodeId: 'cc',
      unitCode: 'nos',
      suppliedBy: 'company',
      quantity: '14.0000',
    });
  });

  it('rejects missing or non-numeric parameter values', () => {
    expect(() => instantiateLines(wall, parameters, { length: '1' })).toThrow(ValidationError);
    expect(() => instantiateLines(wall, parameters, { length: '1', height: 'x' })).toThrow(
      ValidationError,
    );
    expect(() => instantiateLines(wall, parameters, { length: '-1', height: '1' })).toThrow(
      ValidationError,
    );
    expect(() => checkParameterValues(parameters, { constructor: '1', length: '1' })).toThrow(
      ValidationError,
    );
  });

  it('ignores extra values', () => {
    expect(checkParameterValues(parameters, { length: '1', height: '2', extra: '3' }).size).toBe(2);
  });
});

describe('quantity evaluation', () => {
  it('rounds half-up to 4 decimals', () => {
    expect(evaluateQuantity('1 / 3', new Map())).toBe('0.3333');
    expect(evaluateQuantity('2 / 3', new Map())).toBe('0.6667');
    expect(evaluateQuantity('0.00005', new Map())).toBe('0.0001');
  });

  it('rejects a negative quantity but accepts zero', () => {
    expect(() => evaluateQuantity('1 - 2', new Map())).toThrow(ValidationError);
    expect(evaluateQuantity('1 - 1', new Map())).toBe('0.0000');
    expect(evaluateQuantity('-0', new Map())).toBe('0.0000');
  });
});

describe('default rate (BR-3)', () => {
  const prices = [
    { rate: '90.0000', validFrom: '2026-01-01', validTo: '2026-06-30' },
    { rate: '100.0000', validFrom: '2026-07-01', validTo: null },
    { rate: '95.0000', validFrom: '2026-03-01', validTo: null },
    { rate: '120.0000', validFrom: '2027-01-01', validTo: null },
  ];

  it('takes the latest price in force on the date', () => {
    expect(defaultRate(prices, '2026-10-25', '50')).toBe('100.0000');
    expect(defaultRate(prices, '2026-05-01', '50')).toBe('95.0000');
    expect(defaultRate(prices, '2026-02-01', '50')).toBe('90.0000');
    expect(defaultRate(prices, '2026-06-30', null)).toBe('95.0000');
  });

  it('falls back to the template default, then zero', () => {
    expect(defaultRate(prices, '2025-12-31', '50.0000')).toBe('50.0000');
    expect(defaultRate([], '2026-10-25', '50.0000')).toBe('50.0000');
    expect(defaultRate([], '2026-10-25', null)).toBe('0.0000');
  });
});

describe('normalizeDecimal', () => {
  it('pads to the given places', () => {
    expect(normalizeDecimal('5', 'rate', 4)).toBe('5.0000');
    expect(normalizeDecimal(' 12.5 ', 'rate', 2)).toBe('12.50');
    expect(normalizeDecimal('100', 'percent', 4, '100')).toBe('100.0000');
  });

  it('rejects negatives, text, too many decimals and values above the maximum', () => {
    for (const bad of ['-1', 'abc', '1.23456', '', '1e3', '123456789012345']) {
      expect(() => normalizeDecimal(bad, 'rate', 4), bad).toThrow(ValidationError);
    }
    expect(() => normalizeDecimal('100.0001', 'percent', 4, '100')).toThrow(ValidationError);
  });
});
