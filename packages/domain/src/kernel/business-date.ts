import { RuleViolationError, ValidationError } from '../errors.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const instant = new Date(iso);
  return { now: () => new Date(instant) };
}

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000; // Asia/Karachi is UTC+5 all year
const DAY_MS = 24 * 60 * 60 * 1000;

/** A calendar date (yyyy-mm-dd) in Asia/Karachi. */
export class BusinessDate {
  private constructor(private readonly dayNumber: number) {}

  static parse(text: string): BusinessDate {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text) {
      throw new ValidationError('invalid_date', `Invalid business date: ${text}`);
    }
    return new BusinessDate(ms / DAY_MS);
  }

  /** The Asia/Karachi calendar date of an instant. */
  static fromInstant(instant: Date): BusinessDate {
    return new BusinessDate(Math.floor((instant.getTime() + KARACHI_OFFSET_MS) / DAY_MS));
  }

  static today(clock: Clock): BusinessDate {
    return BusinessDate.fromInstant(clock.now());
  }

  get year(): number {
    return new Date(this.dayNumber * DAY_MS).getUTCFullYear();
  }

  addDays(days: number): BusinessDate {
    return new BusinessDate(this.dayNumber + days);
  }

  /** Whole days from `other` to this date (positive when this is later). */
  daysSince(other: BusinessDate): number {
    return this.dayNumber - other.dayNumber;
  }

  isAfter(other: BusinessDate): boolean {
    return this.dayNumber > other.dayNumber;
  }

  toString(): string {
    return new Date(this.dayNumber * DAY_MS).toISOString().slice(0, 10);
  }

  toJSON(): string {
    return this.toString();
  }
}

export function assertNotFuture(date: BusinessDate, clock: Clock): void {
  if (date.isAfter(BusinessDate.today(clock))) {
    throw new RuleViolationError('date_in_future', `Date ${date.toString()} is in the future`);
  }
}

export interface BackdateOverride {
  /** The caller holds `platform.backdate.override`. */
  permitted: boolean;
  reason?: string | undefined;
}

export interface BackdateResult {
  /** True when an older-than-allowed date was accepted through the override and must be audited. */
  overridden: boolean;
  reason?: string;
}

/** Dates up to `days` days before today pass; older ones need the override permission and a reason (BR-5). */
export function assertWithinBackdating(
  date: BusinessDate,
  clock: Clock,
  days: number,
  override?: BackdateOverride,
): BackdateResult {
  assertNotFuture(date, clock);
  if (BusinessDate.today(clock).daysSince(date) <= days) return { overridden: false };
  if (override?.permitted !== true) {
    throw new RuleViolationError(
      'backdating_not_allowed',
      `Date ${date.toString()} is more than ${days} days in the past`,
    );
  }
  const reason = override.reason?.trim() ?? '';
  if (reason === '') {
    throw new RuleViolationError(
      'backdating_reason_required',
      'A reason is required to backdate beyond the allowance',
    );
  }
  return { overridden: true, reason };
}
