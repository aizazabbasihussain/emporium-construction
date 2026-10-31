import type { ScopeGrant } from '@emporium/domain/identity';
import type { Db } from '../platform/index.js';

export type { Db };

/** Who is acting. */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
}

/** BR-1: the login of one worker. */
export interface AccountDto {
  userId: string;
  workerId: string;
  linkedBy: string;
  linkedAt: string;
}

/** What the worker sees of the month: the days of their own approved attendance, with no money. */
export interface OwnAttendanceDto {
  /** `yyyy-mm`. */
  month: string;
  days: { date: string; status: string; overtimeHours: string }[];
}

export interface OwnAdvancesDto {
  /** What the worker still owes on open advances. */
  balance: string;
  /** The advance recovery of each approved wage sheet in the last twelve months, newest first. */
  recoveries: { month: string; amount: string }[];
}

/** The worker's own line of an approved wage sheet; no rate, no other worker, no project. */
export interface OwnWageLineDto {
  presentDays: string;
  halfDays: string;
  paidLeaveDays: string;
  offDays: string;
  absentDays: string;
  overtimeHours: string;
  basicPay: string;
  overtimePay: string;
  allowances: string;
  deductions: string;
  advanceRecovery: string;
  grossPay: string;
  netPay: string;
}

export interface OwnWagesDto {
  month: string;
  /** Null while the month's wage sheet is not approved or holds no line for the worker. */
  line: OwnWageLineDto | null;
}
