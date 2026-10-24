import { describe, expect, it } from 'vitest';
import {
  BusinessDate,
  assertNotFuture,
  assertWithinBackdating,
  fixedClock,
  systemClock,
} from './business-date.js';

// 2026-10-24 22:00 UTC is already 2026-10-25 03:00 in Karachi.
const clock = fixedClock('2026-10-24T10:00:00Z');
const d = (s: string) => BusinessDate.parse(s);

describe('BusinessDate', () => {
  it('parses and formats calendar dates', () => {
    expect(d('2026-02-28').addDays(1).toString()).toBe('2026-03-01');
    expect(d('2024-02-28').addDays(1).toJSON()).toBe('2024-02-29');
    expect(d('2026-10-24').year).toBe(2026);
    expect(d('2026-10-24').daysSince(d('2026-10-20'))).toBe(4);
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => BusinessDate.parse('24/10/2026')).toThrow(/Invalid business date/);
    expect(() => BusinessDate.parse('2026-02-30')).toThrow(/Invalid business date/);
  });

  it('uses the Asia/Karachi calendar day, not UTC', () => {
    expect(BusinessDate.today(fixedClock('2026-12-31T20:00:00Z')).toString()).toBe('2027-01-01');
    expect(BusinessDate.today(fixedClock('2026-12-31T18:59:59Z')).toString()).toBe('2026-12-31');
  });

  it('has a system clock', () => {
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});

describe('backdating rules (T-3)', () => {
  const today = '2026-10-24';

  it('rejects tomorrow, accepts today', () => {
    expect(() => assertNotFuture(d('2026-10-25'), clock)).toThrow(/future/);
    expect(() => assertNotFuture(d(today), clock)).not.toThrow();
    expect(() => assertWithinBackdating(d('2026-10-25'), clock, 3)).toThrow(/future/);
  });

  it('accepts today and today minus the allowance, rejects one day more', () => {
    expect(assertWithinBackdating(d(today), clock, 3)).toEqual({ overridden: false });
    expect(assertWithinBackdating(d('2026-10-21'), clock, 3)).toEqual({ overridden: false });
    expect(() => assertWithinBackdating(d('2026-10-20'), clock, 3)).toThrow(/more than 3 days/);
  });

  it('accepts an older date with permission and reason', () => {
    const result = assertWithinBackdating(d('2026-10-01'), clock, 3, {
      permitted: true,
      reason: '  paper voucher found late ',
    });
    expect(result).toEqual({ overridden: true, reason: 'paper voucher found late' });
  });

  it('rejects an older date without permission or without a reason', () => {
    const old = d('2026-10-01');
    expect(() => assertWithinBackdating(old, clock, 3, { permitted: false, reason: 'x' })).toThrow(
      /more than 3 days/,
    );
    expect(() => assertWithinBackdating(old, clock, 3)).toThrow(/more than 3 days/);
    expect(() => assertWithinBackdating(old, clock, 3, { permitted: true })).toThrow(/reason/);
    expect(() => assertWithinBackdating(old, clock, 3, { permitted: true, reason: '  ' })).toThrow(
      /reason/,
    );
  });
});
