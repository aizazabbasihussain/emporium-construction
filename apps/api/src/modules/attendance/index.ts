// The only public entry point of the attendance module.
import { subscribeToDecisions } from './service/approval-events.service.js';
import { createQueriesService, type QueriesService } from './service/queries.service.js';
import {
  createSheetsService,
  type AttendanceDeps,
  type SheetsService,
} from './service/sheets.service.js';

export interface Attendance {
  sheets: SheetsService;
  queries: QueriesService;
  /** Query interfaces for other modules (spec P1-17 section 2). */
  getApprovedAttendance: QueriesService['getApprovedAttendance'];
  getAttendanceHeadcount: QueriesService['getAttendanceHeadcount'];
  getUnapprovedSheets: QueriesService['getUnapprovedSheets'];
  /** The check workforce makes before a worker is marked as left (P1-16 BR-6). */
  listUnapprovedSheets: QueriesService['listUnapprovedSheets'];
  /** Query interfaces for the labour report (spec P1-19 BR-4). */
  getLabourSummary: QueriesService['getLabourSummary'];
  getHeadcountSeries: QueriesService['getHeadcountSeries'];
}

/**
 * Wires attendance on top of the kernel, workforce, projects, approvals and master data. Reacts to
 * the approval engine's decisions on attendance sheets.
 */
export function createAttendance(deps: AttendanceDeps): Attendance {
  const sheets = createSheetsService(deps);
  const queries = createQueriesService(deps);
  subscribeToDecisions({ platform: deps.platform, sheets });
  return {
    sheets,
    queries,
    getApprovedAttendance: (db, workerId, from, to) =>
      queries.getApprovedAttendance(db, workerId, from, to),
    getAttendanceHeadcount: (db, projectId, date) =>
      queries.getAttendanceHeadcount(db, projectId, date),
    getUnapprovedSheets: (db, period) => queries.getUnapprovedSheets(db, period),
    listUnapprovedSheets: (db, workerId, upTo) => queries.listUnapprovedSheets(db, workerId, upTo),
    getLabourSummary: (db, from, to, projectId) =>
      queries.getLabourSummary(db, from, to, projectId),
    getHeadcountSeries: (db, projectId, from, to) =>
      queries.getHeadcountSeries(db, projectId, from, to),
  };
}

export { registerAttendanceRoutes, type AttendanceRouteDeps } from './routes/attendance.routes.js';
export type { WagePeriods } from './service/sheets.service.js';
export type {
  ApprovedDayDto,
  GridDto,
  HeadcountDto,
  LabourSummaryDto,
  MissingSheetDto,
  SheetDto,
  SheetHeaderDto,
  UnapprovedSheetsDto,
} from './types.js';
