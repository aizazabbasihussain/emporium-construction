import { RuleViolationError } from '../errors.js';
import type { BusinessDate } from './business-date.js';

export interface SeriesFormat {
  prefix: string;
  padding: number;
  resetYearly: boolean;
}

export interface SeriesCounter {
  nextValue: number;
  currentYear: number | null;
  startValue: number;
}

export interface Allocation {
  number: string;
  /** Counter state to store after this allocation. */
  next: { nextValue: number; currentYear: number | null };
}

/** `INV-2026-0001` for yearly series, `INV-0001` otherwise; the year is the Asia/Karachi business year (BR-1). */
export function formatDocumentNumber(format: SeriesFormat, value: number, year: number): string {
  const digits = String(value).padStart(format.padding, '0');
  return format.resetYearly ? `${format.prefix}-${year}-${digits}` : `${format.prefix}-${digits}`;
}

/** Decide the number and the new counter state; a new year resets the counter to the start value. */
export function allocateNumber(
  format: SeriesFormat,
  counter: SeriesCounter,
  today: BusinessDate,
): Allocation {
  const year = today.year;
  const value =
    format.resetYearly && counter.currentYear !== year ? counter.startValue : counter.nextValue;
  return {
    number: formatDocumentNumber(format, value, year),
    next: { nextValue: value + 1, currentYear: format.resetYearly ? year : counter.currentYear },
  };
}

export interface SeriesState {
  gapless: boolean;
  nextValue: number;
  /** True once at least one number has been issued from the series. */
  used: boolean;
}

export interface SeriesChange {
  gapless: boolean;
  nextValue: number;
}

/** BR-2: once a gapless series has issued a number it can no longer be rewound, skipped ahead or made non-gapless. */
export function assertSeriesChangeAllowed(current: SeriesState, change: SeriesChange): void {
  if (!current.gapless || !current.used) return;
  if (!change.gapless) {
    throw new RuleViolationError(
      'gapless_series_locked',
      'A gapless series that has issued numbers cannot become non-gapless',
    );
  }
  if (change.nextValue !== current.nextValue) {
    throw new RuleViolationError(
      'gapless_series_locked',
      'The next number of a gapless series that has issued numbers cannot be changed',
    );
  }
}

export const MAX_DISPATCH_ATTEMPTS = 5;

/** Delay in ms before retry number `attempt` (1-based): 1s, 2s, 4s, ... capped at 60s (BR-6). */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 60_000);
}
