// The only public entry point of the estimation module.
import type { Clock } from '@emporium/domain/kernel';
import type { MasterData } from '../masterdata/index.js';
import type { Platform } from '../platform/index.js';
import { createEstimateService, type EstimateService } from './service/estimates.service.js';
import { createTemplateService, type TemplateService } from './service/templates.service.js';

export interface Estimation {
  templates: TemplateService;
  estimates: EstimateService;
  /** Query interfaces for other modules (spec P1-07 section 2). */
  getEstimate: EstimateService['summary'];
  lockEstimate: EstimateService['lockCurrent'];
  getEstimateCostLines: EstimateService['getCostLines'];
}

/** Wires estimation on top of the kernel and master data. */
export function createEstimation(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  masterData: Pick<MasterData, 'getParty' | 'getItem' | 'catalog' | 'costing'>;
}): Estimation {
  const { masterData, ...rest } = deps;
  const templates = createTemplateService({ ...rest, masters: masterData });
  const estimates = createEstimateService({ ...rest, masters: masterData, masterData });
  return {
    templates,
    estimates,
    getEstimate: (db, id) => estimates.summary(db, id),
    lockEstimate: (id, actor, tx) => estimates.lockCurrent(id, actor, tx),
    getEstimateCostLines: (db, id) => estimates.getCostLines(db, id),
  };
}

export { registerEstimationRoutes, type EstimationRouteDeps } from './routes/estimation.routes.js';
export type {
  EstimateCostLineDto,
  EstimateDto,
  EstimateHeaderDto,
  EstimateLineDto,
  EstimateSummaryDto,
  EstimateTotals,
  TemplateDto,
  TemplateSummaryDto,
} from './types.js';
