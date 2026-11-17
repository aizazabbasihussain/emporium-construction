// The only public entry point of the tax module.
import type { Clock } from '@emporium/domain/kernel';
import type { Approvals } from '../approvals/index.js';
import type { MasterData } from '../masterdata/index.js';
import type { Platform } from '../platform/index.js';
import { subscribeToRuleDecisions } from './service/approval-events.service.js';
import { createEngineService, type EngineService } from './service/engine.service.js';
import { createRulesService, type RulesService } from './service/rules.service.js';

export interface Tax {
  rules: RulesService;
  engine: EngineService;
  /** Module-to-module API (spec P2-01 section 2); billing and payables call these inside their own transaction. */
  resolveAuthority: EngineService['resolveAuthority'];
  calculateSalesTax: EngineService['calculateSalesTax'];
  calculateWithholding: EngineService['calculateWithholding'];
  getTaxRules: EngineService['getTaxRules'];
  taxReportData: EngineService['taxReportData'];
  /** Billing and payables register the view that exposes their stored tax snapshots (BR-8). */
  registerReportSource: EngineService['registerReportSource'];
}

/**
 * Wires the tax engine on top of the kernel, master data (locations, registrations) and
 * approvals. It creates no invoices, bills or payments.
 */
export function createTax(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  masterData: Pick<MasterData, 'listLocations' | 'getRegistration'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
}): Tax {
  const rules = createRulesService(deps);
  const engine = createEngineService({ masterData: deps.masterData, rules });
  subscribeToRuleDecisions({ platform: deps.platform, rules });
  return {
    rules,
    engine,
    resolveAuthority: (db, query) => engine.resolveAuthority(db, query),
    calculateSalesTax: (db, input) => engine.calculateSalesTax(db, input),
    calculateWithholding: (db, input) => engine.calculateWithholding(db, input),
    getTaxRules: (db, date) => engine.getTaxRules(db, date),
    taxReportData: (db, authority, month) => engine.taxReportData(db, authority, month),
    registerReportSource: (source) => engine.registerReportSource(source),
  };
}

export { registerTaxRoutes, type TaxRouteDeps } from './routes/tax.routes.js';
export type {
  AuthorityDto,
  RegionMapDto,
  SalesRuleDto,
  TaxSettingsDto,
  WithholdingRuleDto,
} from './types.js';
export type {
  AuthorityResolution,
  SalesTaxInput,
  TaxReportData,
  TaxReportSource,
  TaxRulesOnDate,
  TaxSnapshot,
  WithholdingInput,
} from './service/engine.service.js';
