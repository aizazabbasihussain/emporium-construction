import { describe, expect, it } from 'vitest';
import { RuleViolationError, ValidationError } from '../errors.js';
import { BusinessDate } from '../kernel/business-date.js';
import {
  MAX_VALIDITY_DAYS,
  assertAcceptanceProof,
  assertValidityDays,
  displayNumber,
  expiryDate,
  isBelowFloor,
  isExpired,
  marginPanel,
  marginPercent,
  requireText,
} from './rules.js';

describe('margin (BR-2)', () => {
  it('is (price - cost) / price in percent to four decimals', () => {
    expect(marginPercent('1000.00', '850.00')).toBe('15.0000');
    expect(marginPercent('300.00', '200.00')).toBe('33.3333');
    expect(marginPercent('100.00', '120.00')).toBe('-20.0000');
  });

  it('is below the floor only when strictly less (boundary)', () => {
    expect(isBelowFloor('14.9999', '15')).toBe(true);
    expect(isBelowFloor('15.0000', '15')).toBe(false);
    expect(isBelowFloor('15.0001', '15')).toBe(false);
    expect(isBelowFloor('-1.0000', '0')).toBe(true);
  });
});

describe('margin panel (BR-2)', () => {
  it('reports cost, margin amount and percent against the floor', () => {
    expect(marginPanel('1000.00', '850.00', '15')).toEqual({
      totalCost: '850.00',
      marginAmount: '150.00',
      marginPercent: '15.0000',
      floorPercent: '15.0000',
      belowFloor: false,
    });
    expect(marginPanel('1000.00', '850.01', '15').belowFloor).toBe(true);
    expect(marginPanel('1000.00', '1200', '0')).toMatchObject({
      marginAmount: '-200.00',
      belowFloor: true,
    });
  });
});

describe('numbers and validity (BR-5, BR-7)', () => {
  it('adds the revision suffix after the first revision', () => {
    expect(displayNumber('QUO-2026-0001', 1)).toBe('QUO-2026-0001');
    expect(displayNumber('QUO-2026-0001', 2)).toBe('QUO-2026-0001/2');
    expect(displayNumber('QUO-2026-0001', 3)).toBe('QUO-2026-0001/3');
  });

  it('accepts validity from 1 to 365 whole days', () => {
    expect(() => assertValidityDays(1)).not.toThrow();
    expect(() => assertValidityDays(MAX_VALIDITY_DAYS)).not.toThrow();
    for (const days of [0, -1, 366, 1.5, Number.NaN]) {
      expect(() => assertValidityDays(days)).toThrow(ValidationError);
    }
  });

  it('computes the inclusive expiry boundary (T-4)', () => {
    const issued = BusinessDate.parse('2026-10-01');
    const expires = expiryDate(issued, 30);
    expect(expires.toString()).toBe('2026-10-31');
    expect(isExpired(expires, BusinessDate.parse('2026-10-30'))).toBe(false);
    expect(isExpired(expires, BusinessDate.parse('2026-10-31'))).toBe(false);
    expect(isExpired(expires, BusinessDate.parse('2026-11-01'))).toBe(true);
  });
});

describe('acceptance and reasons (BR-6, BR-10)', () => {
  it('requires an attachment for government only (T-5)', () => {
    expect(() => assertAcceptanceProof('government', false)).toThrow(RuleViolationError);
    expect(() => assertAcceptanceProof('government', true)).not.toThrow();
    expect(() => assertAcceptanceProof('private', false)).not.toThrow();
    expect(() => assertAcceptanceProof('private', true)).not.toThrow();
  });

  it('requires non-blank text and trims it', () => {
    expect(requireText('  too dear ', 'reason_required')).toBe('too dear');
    for (const blank of [null, undefined, '', '   ']) {
      expect(() => requireText(blank, 'reason_required')).toThrow(ValidationError);
    }
  });
});
