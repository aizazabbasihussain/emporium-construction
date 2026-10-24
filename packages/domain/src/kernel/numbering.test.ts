import { describe, expect, it } from 'vitest';
import { BusinessDate } from './business-date.js';
import {
  MAX_DISPATCH_ATTEMPTS,
  allocateNumber,
  assertSeriesChangeAllowed,
  formatDocumentNumber,
  retryDelayMs,
} from './numbering.js';

const yearly = { prefix: 'INV', padding: 4, resetYearly: true };
const plain = { prefix: 'PO', padding: 3, resetYearly: false };
const day = BusinessDate.parse('2026-10-24');

describe('document numbers (BR-1)', () => {
  it('formats yearly and plain series', () => {
    expect(formatDocumentNumber(yearly, 1, 2026)).toBe('INV-2026-0001');
    expect(formatDocumentNumber(plain, 12, 2026)).toBe('PO-012');
    expect(formatDocumentNumber(plain, 12345, 2026)).toBe('PO-12345');
  });

  it('continues within the same year', () => {
    const a = allocateNumber(yearly, { nextValue: 5, currentYear: 2026, startValue: 1 }, day);
    expect(a).toEqual({ number: 'INV-2026-0005', next: { nextValue: 6, currentYear: 2026 } });
  });

  it('resets to the start value on the first allocation of a new year', () => {
    const a = allocateNumber(yearly, { nextValue: 99, currentYear: 2025, startValue: 1 }, day);
    expect(a.number).toBe('INV-2026-0001');
    expect(a.next).toEqual({ nextValue: 2, currentYear: 2026 });
    const first = allocateNumber(yearly, { nextValue: 1, currentYear: null, startValue: 40 }, day);
    expect(first.number).toBe('INV-2026-0040');
  });

  it('never resets a non-yearly series', () => {
    const a = allocateNumber(plain, { nextValue: 7, currentYear: null, startValue: 1 }, day);
    expect(a).toEqual({ number: 'PO-007', next: { nextValue: 8, currentYear: null } });
  });
});

describe('gapless series changes (BR-2)', () => {
  const used = { gapless: true, nextValue: 10, used: true };

  it('allows anything on unused or non-gapless series', () => {
    expect(() =>
      assertSeriesChangeAllowed({ ...used, used: false }, { gapless: false, nextValue: 1 }),
    ).not.toThrow();
    expect(() =>
      assertSeriesChangeAllowed({ ...used, gapless: false }, { gapless: false, nextValue: 1 }),
    ).not.toThrow();
  });

  it('locks a used gapless series', () => {
    expect(() => assertSeriesChangeAllowed(used, { gapless: true, nextValue: 10 })).not.toThrow();
    expect(() => assertSeriesChangeAllowed(used, { gapless: true, nextValue: 11 })).toThrow(
      /next number/,
    );
    expect(() => assertSeriesChangeAllowed(used, { gapless: true, nextValue: 9 })).toThrow(
      /next number/,
    );
    expect(() => assertSeriesChangeAllowed(used, { gapless: false, nextValue: 10 })).toThrow(
      /non-gapless/,
    );
  });
});

describe('retry backoff (BR-6)', () => {
  it('doubles and caps', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(retryDelayMs(20)).toBe(60_000);
    expect(MAX_DISPATCH_ATTEMPTS).toBe(5);
  });
});
