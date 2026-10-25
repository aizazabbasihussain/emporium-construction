// The only public entry point of the valuation module.
import type { Clock } from '@emporium/domain/kernel';
import type { Approvals } from '../approvals/index.js';
import type { MasterData } from '../masterdata/index.js';
import type { Platform } from '../platform/index.js';
import { subscribeToPolicyDecisions } from './service/approval-events.service.js';
import { createLedgerService, type LedgerService } from './service/ledger.service.js';
import { createPoliciesService, type PoliciesService } from './service/policies.service.js';
import { createReportsService, type ReportsService } from './service/reports.service.js';

export interface Valuation {
  policies: PoliciesService;
  ledger: LedgerService;
  reports: ReportsService;
  /** Module-to-module API (spec P1-13 section 2); inventory calls these inside its own transaction. */
  recordReceipt: LedgerService['recordReceipt'];
  valueIssue: LedgerService['valueIssue'];
  recordTransfer: LedgerService['recordTransfer'];
  recordReturn: LedgerService['recordReturn'];
  getStockValue: ReportsService['getStockValue'];
  getTotalValue: ReportsService['getTotalValue'];
  resolvePolicy: PoliciesService['resolvePolicy'];
  setPolicy: PoliciesService['setPolicy'];
  requestTransition: LedgerService['runTransitions'];
}

/**
 * Wires valuation on top of the kernel, master data (item to category) and approvals. Inventory
 * calls valuation; valuation never calls inventory.
 */
export function createValuation(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  masterData: Pick<MasterData, 'getItem' | 'getItemCategory'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
}): Valuation {
  const policies = createPoliciesService(deps);
  const ledger = createLedgerService({ ...deps, policies });
  const reports = createReportsService({ clock: deps.clock, policies });
  subscribeToPolicyDecisions({ platform: deps.platform, policies });
  return {
    policies,
    ledger,
    reports,
    recordReceipt: (input, actor, tx) => ledger.recordReceipt(input, actor, tx),
    valueIssue: (input, actor, tx) => ledger.valueIssue(input, actor, tx),
    recordTransfer: (input, actor, tx) => ledger.recordTransfer(input, actor, tx),
    recordReturn: (input, actor, tx) => ledger.recordReturn(input, actor, tx),
    getStockValue: (db, storeId, itemId) => reports.getStockValue(db, storeId, itemId),
    getTotalValue: (db, filter) => reports.getTotalValue(db, filter),
    resolvePolicy: (db, itemId, date) => policies.resolvePolicy(db, itemId, date),
    setPolicy: (input, actor, tx) => policies.setPolicy(input, actor, tx),
    requestTransition: (actor, tx) => ledger.runTransitions(actor, tx),
  };
}

export { registerValuationRoutes, type ValuationRouteDeps } from './routes/valuation.routes.js';
export type {
  MovementDto,
  MovementResult,
  PartDto,
  PolicyDto,
  StockValueDto,
  StockValueReport,
  TransferResult,
  TransitionDto,
} from './types.js';
