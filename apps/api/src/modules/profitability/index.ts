// The only public entry point of the profitability module.
import { profitabilityNotificationTemplates } from '@emporium/shared';
import type { ProfitabilityDeps } from './service/context.js';
import {
  createProfitabilityService,
  type ProfitabilityService,
} from './service/profitability.service.js';

export interface Profitability {
  service: ProfitabilityService;
  /** Module interfaces for other modules (spec P2-08 section 2). */
  getProjectFinancials: ProfitabilityService['getProjectFinancials'];
  listProjectFinancials: ProfitabilityService['listProjectFinancials'];
  /** The scheduler's job: raises and clears the alerts of BR-4 inside a transaction. */
  evaluateAlerts: ProfitabilityService['evaluateAlerts'];
}

/**
 * Wires profitability on top of the query interfaces of variations, projects, billing, receivables,
 * payables, payroll and expenses. It owns only alert settings, forecasts and alert state.
 */
export function createProfitability(deps: ProfitabilityDeps): Profitability {
  for (const [code, key] of Object.entries(profitabilityNotificationTemplates)) {
    deps.notifications.registerTemplate(code, key);
  }
  const service = createProfitabilityService(deps);
  return {
    service,
    getProjectFinancials: (db, projectId, asOf, actor) =>
      service.getProjectFinancials(db, projectId, asOf, actor),
    listProjectFinancials: (db, filters, actor) =>
      service.listProjectFinancials(db, filters, actor),
    evaluateAlerts: (tx) => service.evaluateAlerts(tx),
  };
}

export {
  registerProfitabilityRoutes,
  type ProfitabilityRouteDeps,
} from './routes/profitability.routes.js';
export type { ProfitabilityDeps } from './service/context.js';
export type { DownloadDto } from './service/profitability.service.js';
export type {
  AlertDto,
  ForecastDto,
  PortfolioDto,
  PortfolioRowDto,
  ProjectFinancialsDto,
  ThresholdDto,
} from './types.js';
