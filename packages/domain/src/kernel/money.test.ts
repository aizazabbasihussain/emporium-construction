import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { Money, Percent, Quantity, Rate, roundMoney } from './money.js';

describe('Money', () => {
  it('accepts strings, integers, bigint and Decimal', () => {
    expect(Money.of('10.5').toString()).toBe('10.50');
    expect(Money.of(7).toString()).toBe('7.00');
    expect(Money.of(12n).toString()).toBe('12.00');
    expect(Money.of(new Decimal('1.005')).toString()).toBe('1.01');
    expect(Money.of(' 3.10 ').toJSON()).toBe('3.10');
  });

  it('rejects floats and malformed input (AC-3)', () => {
    expect(() => Money.of(0.1)).toThrow(/float/);
    expect(() => Money.of(Number.NaN)).toThrow(/float/);
    expect(() => Money.of('abc')).toThrow(/valid decimal/);
    expect(() => Money.of('1e3')).toThrow(/valid decimal/);
    expect(() => Money.of(null as unknown as string)).toThrow(/valid decimal/);
  });

  it('rounds half-up (away from zero) at 2 decimals', () => {
    expect(Money.of('0.125').toString()).toBe('0.13');
    expect(Money.of('0.124').toString()).toBe('0.12');
    expect(Money.of('-0.125').toString()).toBe('-0.13');
  });

  it('adds, subtracts, negates and compares', () => {
    const a = Money.of('10.10');
    const b = Money.of('0.20');
    expect(a.add(b).toString()).toBe('10.30');
    expect(a.sub(b).toString()).toBe('9.90');
    expect(a.negate().toString()).toBe('-10.10');
    expect(a.negate().isNegative()).toBe(true);
    expect(Money.zero().isNegative()).toBe(false);
    expect(Money.zero().negate().isNegative()).toBe(false);
    expect(Money.zero().isZero()).toBe(true);
    expect(a.isZero()).toBe(false);
    expect(a.compare(b)).toBe(1);
    expect(a.equals(Money.of('10.1'))).toBe(true);
  });

  it('keeps products exact until roundMoney is called', () => {
    const base = Money.of('100.00');
    const product = base.times(Rate.of('0.3333'));
    expect(product.toString()).toBe('33.33');
    expect(roundMoney(Money.of('1.00').times(Rate.of('0.3333'))).toString()).toBe('0.33');
    const tax = base.percent(Percent.of('18.5'));
    expect(tax.toString()).toBe('18.5');
    expect(roundMoney(Money.of('0.05').percent(Percent.of('50'))).toString()).toBe('0.03');
    expect(roundMoney(Money.of('2.00').times(Quantity.of('1.5'))).toString()).toBe('3.00');
    expect(tax.plus(tax).toString()).toBe('37');
    expect(roundMoney(Money.of('5.5')).toString()).toBe('5.50');
  });
});

describe('Quantity', () => {
  it('allows 4 decimals and rejects a fifth', () => {
    expect(Quantity.of('1.2345').toString()).toBe('1.2345');
    expect(Quantity.of(3).toString()).toBe('3.0000');
    expect(() => Quantity.of('1.23456')).toThrow(/4 decimal/);
    expect(() => Quantity.of(0.5)).toThrow(/float/);
  });

  it('rejects negatives unless a spec allows them (BR-4)', () => {
    expect(() => Quantity.of('-1')).toThrow(/negative/);
    expect(Quantity.of('0').isZero()).toBe(true);
    expect(Quantity.of('-0').toString()).toBe('0.0000');
    expect(Quantity.of('-2.5', { allowNegative: true }).toString()).toBe('-2.5000');
    expect(Quantity.of('1', { allowNegative: false }).add(Quantity.of('2')).toString()).toBe(
      '3.0000',
    );
  });
});

describe('Rate and Percent', () => {
  it('enforce 4 decimal places', () => {
    expect(Rate.of('12.3456').toString()).toBe('12.3456');
    expect(() => Rate.of('1.00001')).toThrow(/4 decimal/);
    expect(Percent.of('18').toString()).toBe('18.0000');
    expect(() => Percent.of('1.00001')).toThrow(/4 decimal/);
    expect(Rate.of('1').add(Rate.of('2')).toString()).toBe('3.0000');
    expect(Percent.of('1').sub(Percent.of('2')).toString()).toBe('-1.0000');
  });
});
