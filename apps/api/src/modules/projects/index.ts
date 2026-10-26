// The only public entry point of the projects module.
import type { Clock } from '@emporium/domain/kernel';
import type { Estimation } from '../estimation/index.js';
import type { Identity } from '../identity/index.js';
import type { MasterData } from '../masterdata/index.js';
import type { Platform } from '../platform/index.js';
import type { Quotations } from '../quotations/index.js';
import { costCodeUsage, projectUsesParty } from './repo/projects.repo.js';
import { createCostingService, type CostingService } from './service/costing.service.js';
import { createProjectService, type ProjectService } from './service/projects.service.js';
import { subscribeToQuotationAccepted } from './service/quotation-events.service.js';

export interface Projects {
  service: ProjectService;
  costing: CostingService;
  /** Query and posting interfaces for other modules (spec P1-09 section 2). */
  getProject: ProjectService['summary'];
  listProjectsForUser: ProjectService['listForUser'];
  addBudgetLine: ProjectService['addBudgetLine'];
  getEstimateBudgetSource: ProjectService['getEstimateBudgetSource'];
  postCost: CostingService['postCost'];
  reverseCost: CostingService['reverseCost'];
  transitionCost: CostingService['transitionCost'];
  getCostSummary: CostingService['getCostSummary'];
}

/**
 * Wires projects on top of the kernel, identity, master data, quotations and estimation. Reacts to
 * `quotation.accepted` and tells master data when a client or a cost code is in use.
 */
export function createProjects(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  /** ALLOW_GOVERNMENT_DATA (constitution 9.3). */
  allowGovernmentData: boolean;
  masterData: Pick<
    MasterData,
    | 'getParty'
    | 'listLocations'
    | 'getCostCode'
    | 'registerCostCodeUsage'
    | 'registerReferenceCheck'
  >;
  identity: Pick<Identity, 'users'>;
  quotations: Pick<Quotations, 'getQuotation'>;
  estimation: Pick<Estimation, 'getEstimateCostLines'>;
}): Projects {
  const service = createProjectService(deps);
  const costing = createCostingService(deps);
  subscribeToQuotationAccepted({ platform: deps.platform, projects: service });
  deps.masterData.registerCostCodeUsage(costCodeUsage);
  deps.masterData.registerReferenceCheck('party', projectUsesParty);
  return {
    service,
    costing,
    getProject: (db, id) => service.summary(db, id),
    listProjectsForUser: (db, actor) => service.listForUser(db, actor),
    addBudgetLine: (projectId, line, tx, actor) =>
      service.addBudgetLine(projectId, line, tx, actor),
    getEstimateBudgetSource: (db, id) => service.getEstimateBudgetSource(db, id),
    postCost: (entry, tx) => costing.postCost(entry, tx),
    reverseCost: (entryId, reason, tx, by) => costing.reverseCost(entryId, reason, tx, by),
    transitionCost: (entryId, to, tx, by) => costing.transitionCost(entryId, to, tx, by),
    getCostSummary: (db, costObject) => costing.getCostSummary(db, costObject),
  };
}

export { registerProjectsRoutes, type ProjectsRouteDeps } from './routes/projects.routes.js';
export type { PostCostInput } from './service/costing.service.js';
export type {
  BudgetDto,
  BudgetLineDto,
  CostEntryDto,
  CostSummaryDto,
  ProjectDetailDto,
  ProjectDto,
  TaskDto,
} from './types.js';
