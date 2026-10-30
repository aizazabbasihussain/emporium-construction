import type { SheetStatus } from '@emporium/domain/attendance';
import type { ScopeGrant } from '@emporium/domain/identity';
import type { EntryStatus } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db, EntryStatus, SheetStatus };

/** Who is acting; a supervisor reaches only the teams and projects assigned to them. */
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

export interface SheetHeaderDto {
  id: string;
  teamId: string;
  sheetDate: string;
  status: SheetStatus;
  /** Null for a supervisor, who never receives pay information. */
  total: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  unlockReason: string | null;
  version: number;
}

export interface AllocationDto {
  id: string;
  projectId: string;
  fraction: string;
  costCodeId: string;
  /** Null for a supervisor, and before the sheet is first submitted. */
  amount: string | null;
}

export interface EntryDto {
  id: string;
  lineNo: number;
  workerId: string;
  workerCode: string;
  workerName: string;
  status: EntryStatus;
  overtimeHours: string;
  overtimeProjectId: string | null;
  remarks: string | null;
  /** Null for a supervisor, and before the sheet is first submitted. */
  dayValue: string | null;
  overtimeValue: string | null;
  allocations: AllocationDto[];
}

export interface SheetDto extends SheetHeaderDto {
  entries: EntryDto[];
  /** BR-8: the comment of the approver who rejected the sheet is in `lastComment`. */
  approval: {
    status: string;
    requestId: string | null;
    currentRole: string | null;
    lastComment: string | null;
  };
}

/** A worker who belongs to a team on the date, as the grid lists them. */
export interface GridMemberDto {
  workerId: string;
  code: string;
  fullName: string;
  tradeCode: string;
}

export interface GridDto {
  teamId: string;
  date: string;
  members: GridMemberDto[];
  /** Null while nothing has been saved for the team and date. */
  sheet: SheetDto | null;
}

export interface MissingSheetDto {
  teamId: string;
  teamCode: string;
  teamName: string;
  date: string;
}

/** What `getUnapprovedSheets` reports to wages (BR-9). */
export interface UnapprovedSheetsDto {
  sheets: { id: string; teamId: string; date: string; status: SheetStatus }[];
  missing: { teamId: string; date: string }[];
}

/** What `getApprovedAttendance` returns to wages: one item per worker and approved day. */
/** P1-19 BR-4: worker-days and labour cost of one project in one month (approved attendance). */
export interface LabourSummaryDto {
  projectId: string;
  /** `yyyy-mm`. */
  month: string;
  workerDays: string;
  cost: string;
}

/** P1-19 BR-4: the workers on a project on one date. */
export interface HeadcountDto {
  date: string;
  headcount: number;
}

export interface ApprovedDayDto {
  sheetId: string;
  teamId: string;
  date: string;
  workerId: string;
  status: EntryStatus;
  overtimeHours: string;
  dayValue: string;
  overtimeValue: string;
  allocations: { projectId: string; fraction: string; amount: string }[];
}
