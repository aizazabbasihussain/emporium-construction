// The only public entry point of the dpr module.
import { dprNotificationTemplates, dprReportEntityType } from '@emporium/shared';
import {
  createReportService,
  type DprDeps,
  type ReportService,
} from './service/reports.service.js';

export interface Dpr {
  reports: ReportService;
  /** Query interfaces for other modules (spec P1-15 section 2). */
  getDpr: ReportService['get'];
  listDprs: ReportService['list'];
  getMissingDprs: ReportService['getMissing'];
  /** The 18:00 Asia/Karachi job (BR-6); the scheduler calls it every tick. */
  notifyMissingDprs: ReportService['notifyMissing'];
}

/**
 * Wires daily progress reports on top of the kernel, projects, files and notifications. Registers
 * the access rule for report photos and the template of the missing-report notification.
 */
export function createDpr(deps: DprDeps): Dpr {
  for (const [code, key] of Object.entries(dprNotificationTemplates)) {
    deps.notifications.registerTemplate(code, key);
  }
  const reports = createReportService(deps);
  deps.files.registerFileAccess(dprReportEntityType, (request) => reports.photoAccess(request));
  return {
    reports,
    getDpr: (db, id, actor) => reports.get(db, id, actor),
    listDprs: (db, query, actor) => reports.list(db, query, actor),
    getMissingDprs: (db, date) => reports.getMissing(db, date),
    notifyMissingDprs: (tx, now) => reports.notifyMissing(tx, now),
  };
}

export { registerDprRoutes, type DprRouteDeps } from './routes/dpr.routes.js';
export type { MissingReportDto, ReportDto, ReportHeaderDto, TaskUpdateDto } from './types.js';
