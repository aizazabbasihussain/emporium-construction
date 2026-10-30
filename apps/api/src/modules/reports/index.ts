// The only public entry point of the reports module.
import { createReportsService, type ReportsService } from './service/reports.service.js';
import type { ReportsDeps } from './service/context.js';

export interface Reports {
  service: ReportsService;
}

/**
 * Wires the operational reports on top of the exported query interfaces of projects, procurement,
 * inventory, attendance, CRM, daily reports and master data. It owns only the saved filters.
 */
export function createReports(deps: ReportsDeps): Reports {
  return { service: createReportsService(deps) };
}

export { registerReportsRoutes, type ReportsRouteDeps } from './routes/reports.routes.js';
export type { ReportsDeps } from './service/context.js';
export type { DownloadDto } from './service/reports.service.js';
export type { Cell, Column, ReportPageDto, Row, SavedFilterDto, Section } from './types.js';
