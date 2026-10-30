/**
 * Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the reports module.
 * The action and resource parts allow letters, digits and underscores only, so the spec's
 * project-cost is spelled project_cost.
 */
export const reportsPermissions = {
  projectCostRead: 'reports.project_cost.read',
  stockRead: 'reports.stock.read',
  purchasingRead: 'reports.purchasing.read',
  labourRead: 'reports.labour.read',
  dprRead: 'reports.dpr.read',
  pipelineRead: 'reports.pipeline.read',
} as const;

export type ReportsPermission = (typeof reportsPermissions)[keyof typeof reportsPermissions];

/** Roles that receive each permission (spec P1-19 section 6). Supervisors have none. */
export const reportsPermissionGrants: Record<ReportsPermission, readonly string[]> = {
  'reports.project_cost.read': ['management', 'project_manager', 'accountant'],
  'reports.stock.read': ['storekeeper', 'procurement', 'management', 'accountant'],
  'reports.purchasing.read': ['procurement', 'management'],
  'reports.labour.read': ['management', 'accountant'],
  'reports.dpr.read': ['project_manager', 'management'],
  'reports.pipeline.read': ['management', 'project_manager'],
};

/** The report codes: the path segment of each endpoint and the key of saved filters. */
export const reportCodes = [
  'project-cost',
  'stock',
  'purchasing',
  'labour',
  'dpr-compliance',
  'pipeline',
  'client-material',
] as const;
export type ReportCode = (typeof reportCodes)[number];

/** The permission that opens each report. The client material report follows the stock report. */
export const reportPermission: Record<ReportCode, ReportsPermission> = {
  'project-cost': 'reports.project_cost.read',
  stock: 'reports.stock.read',
  purchasing: 'reports.purchasing.read',
  labour: 'reports.labour.read',
  'dpr-compliance': 'reports.dpr.read',
  pipeline: 'reports.pipeline.read',
  'client-material': 'reports.stock.read',
};

export const reportFormats = ['json', 'csv', 'xlsx'] as const;
export type ReportFormat = (typeof reportFormats)[number];

/** BR-10: larger exports are refused. BR-11: page sizes. */
export const EXPORT_ROW_LIMIT = 50_000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
