import type { PayBasis, PeriodStatus } from '@emporium/domain/wages';
import type { ScopeGrant } from '@emporium/domain/identity';
import type { AdjustmentKind, WageAdvanceStatus } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { AdjustmentKind, Db, PayBasis, PeriodStatus, WageAdvanceStatus };

/** Who is acting. */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PeriodDto {
  id: string;
  year: number;
  month: number;
  from: string;
  to: string;
  status: PeriodStatus;
  calculatedAt: string | null;
  /** The net pay of the period; frozen when it is submitted. */
  totalNet: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  reopenReason: string | null;
  version: number;
}

export interface LineDto {
  id: string;
  periodId: string;
  workerId: string;
  workerCode: string;
  workerName: string;
  payBasis: PayBasis;
  rate: string;
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
  roundingAdjustment: string;
  /** BR-5: deductions beyond the gross pay, left for a manual decision. */
  shortfall: string;
  note: string | null;
}

export interface AdjustmentDto {
  id: string;
  lineId: string;
  kind: AdjustmentKind;
  amount: string;
  reason: string;
  addedBy: string | null;
  addedAt: string;
}

export interface TotalsDto {
  basicPay: string;
  overtimePay: string;
  allowances: string;
  deductions: string;
  advanceRecovery: string;
  grossPay: string;
  netPay: string;
  roundingAdjustment: string;
}

/** BR-9, BR-5: what the approver acknowledges when submitting. */
export interface WarningsDto {
  /** Attendance sheets of the month that are not approved; they block submission. */
  unapprovedSheets: { id: string; teamId: string; date: string; status: string }[];
  /** Team-days of the month with no sheet at all. */
  missingSheets: { teamId: string; date: string }[];
  /** Workers whose deductions are more than their gross pay. */
  shortfalls: { workerId: string; workerName: string; amount: string }[];
}

export interface PeriodDetailDto extends PeriodDto {
  totals: TotalsDto;
  lineCount: number;
  warnings: WarningsDto;
  approval: {
    status: string;
    requestId: string | null;
    currentRole: string | null;
    lastComment: string | null;
  };
}

export interface LinesDto {
  period: PeriodDto;
  lines: LineDto[];
  adjustments: AdjustmentDto[];
  totals: TotalsDto;
}

export interface AdvanceDto {
  id: string;
  workerId: string;
  workerCode: string | null;
  workerName: string | null;
  amount: string;
  issuedOn: string;
  monthlyRecovery: string;
  /** What is still owed: the amount less the recoveries of approved periods. */
  balance: string;
  status: WageAdvanceStatus;
  note: string | null;
  version: number;
}

export interface ReconciliationDto {
  period: PeriodDto;
  rows: {
    workerId: string;
    workerCode: string | null;
    workerName: string | null;
    allocated: string;
    gross: string;
    difference: string;
  }[];
  differences: ReconciliationDto['rows'];
  totals: { allocated: string; gross: string; difference: string };
}

/** The approved wage sheet other modules read (`getApprovedWageSheet`). */
export interface ApprovedWageSheetDto {
  period: PeriodDto;
  lines: LineDto[];
  totals: TotalsDto;
}
