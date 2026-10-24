import { describe, expect, it } from 'vitest';
import { formatAmount, formatDate, formatDateTimeUtc } from './format.js';

describe('formatters (BR-11)', () => {
  it('formats dates as dd/mm/yyyy in Karachi time', () => {
    expect(formatDate('2026-10-24T10:00:00Z')).toBe('24/10/2026');
    expect(formatDate('2026-10-24T20:00:00Z')).toBe('25/10/2026');
    expect(formatDate(new Date('2026-01-05T00:00:00Z'))).toBe('05/01/2026');
  });

  it('formats date and time in UTC', () => {
    expect(formatDateTimeUtc('2026-10-24T10:05:00Z')).toBe('24/10/2026 10:05');
  });

  it('formats amounts with two decimals through the en-PK locale', () => {
    expect(formatAmount('1234.5')).toBe('1,234.50');
    expect(formatAmount('0')).toBe('0.00');
  });
});
