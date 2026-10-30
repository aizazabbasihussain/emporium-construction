// The only public entry point of the wages module.
import { subscribeToDecisions } from './service/approval-events.service.js';
import { createAdvancesService, type AdvancesService } from './service/advances.service.js';
import {
  createPeriodsService,
  type PeriodsService,
  type WagePayments,
  type WagesDeps,
} from './service/periods.service.js';

export interface Wages {
  periods: PeriodsService;
  advances: AdvancesService;
  /** Query interfaces for other modules (spec P1-18 section 2). */
  getApprovedWageSheet: PeriodsService['getApprovedWageSheet'];
  getWorkerAdvanceBalance: AdvancesService['getWorkerAdvanceBalance'];
  /** The check attendance makes before it unlocks a sheet (P1-17 BR-7). */
  approvedPeriodOf: PeriodsService['approvedPeriodOf'];
}

/**
 * Wires wages on top of the kernel, workforce, attendance and approvals. Reacts to the approval
 * engine's decisions on wage periods.
 */
export function createWages(deps: WagesDeps): Wages {
  const periods = createPeriodsService(deps);
  const advances = createAdvancesService(deps);
  subscribeToDecisions({ platform: deps.platform, periods });
  return {
    periods,
    advances,
    getApprovedWageSheet: (db, period) => periods.getApprovedWageSheet(db, period),
    getWorkerAdvanceBalance: (db, workerId) => advances.getWorkerAdvanceBalance(db, workerId),
    approvedPeriodOf: (db, date) => periods.approvedPeriodOf(db, date),
  };
}

export { registerWagesRoutes, type WagesRouteDeps } from './routes/wages.routes.js';
export type { WagePayments, WagesDeps };
export type {
  AdjustmentDto,
  AdvanceDto,
  ApprovedWageSheetDto,
  LineDto,
  LinesDto,
  PeriodDetailDto,
  PeriodDto,
  ReconciliationDto,
} from './types.js';
