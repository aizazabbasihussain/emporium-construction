import { ValidationError } from '../errors.js';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): { year: number; month: number } {
  const match = DATE.exec(date);
  const month = match === null ? 0 : Number(match[2]);
  if (match === null || month < 1 || month > 12) {
    throw new ValidationError('invalid_date', `Not a date: ${date}`);
  }
  return { year: Number(match[1]), month };
}

/** BR-7: the start month of the fiscal year (H-06); 1 is January, 7 is July. */
export function assertStartMonth(startMonth: number): void {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new ValidationError('invalid_fiscal_start', 'The fiscal year starts in month 1 to 12');
  }
}

/** The calendar year in which the fiscal year of a date began. */
export function fiscalStartYear(date: string, startMonth: number): number {
  assertStartMonth(startMonth);
  const { year, month } = parts(date);
  return month >= startMonth ? year : year - 1;
}

/** `FY2026-27` for a July start, `FY2026` for a January start; for labels and period filters only. */
export function fiscalLabel(date: string, startMonth: number): string {
  const year = fiscalStartYear(date, startMonth);
  if (startMonth === 1) return `FY${year}`;
  return `FY${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

/** The first and last day of the fiscal year that began in `startYear`. */
export function fiscalRange(startYear: number, startMonth: number): { from: string; to: string } {
  assertStartMonth(startMonth);
  const pad = (n: number) => String(n).padStart(2, '0');
  const from = `${startYear}-${pad(startMonth)}-01`;
  if (startMonth === 1) return { from, to: `${startYear}-12-31` };
  const endMonth = startMonth - 1;
  const last = new Date(Date.UTC(startYear + 1, endMonth, 0)).getUTCDate();
  return { from, to: `${startYear + 1}-${pad(endMonth)}-${pad(last)}` };
}

/** `2026-10` for a date. */
export function monthOf(date: string): string {
  const { year, month } = parts(date);
  return `${year}-${String(month).padStart(2, '0')}`;
}
