// The only public entry point of the variations module.
import type { Clock } from '@emporium/domain/kernel';
import { variationEntityType } from '@emporium/shared';
import type { Approvals } from '../approvals/index.js';
import type { Files } from '../files/index.js';
import type { MasterData } from '../masterdata/index.js';
import type { Platform } from '../platform/index.js';
import type { Projects } from '../projects/index.js';
import { canAccessClientDocument } from './policy/variations.policy.js';
import { createVariationService, type VariationService } from './service/variations.service.js';

export interface Variations {
  service: VariationService;
  /** Query interfaces for other modules (spec P1-10 section 2). */
  getCurrentContractValue: (
    ...args: Parameters<VariationService['contractValue']>
  ) => Promise<string>;
  listApprovedVariations: VariationService['listApproved'];
}

/**
 * Wires variations on top of the kernel, projects, approvals, master data and files. Registers the
 * access rule for the client's approval document (BR-4).
 */
export function createVariations(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject' | 'addBudgetLine' | 'costing'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState' | 'cancelApproval'>;
  masterData: Pick<MasterData, 'getCostCode'>;
  files: Pick<Files, 'list' | 'registerFileAccess'>;
  ledgerPageSize?: number;
}): Variations {
  const service = createVariationService(deps);
  deps.files.registerFileAccess(
    variationEntityType,
    async ({ actor, entityId, operation, db }) =>
      canAccessClientDocument({
        permissions: actor.permissions,
        operation,
        variationExists: await service.exists(db, entityId),
      }),
    // The client's signed approval backs a change of contract value: its files are kept.
    { retainForever: true },
  );
  return {
    service,
    getCurrentContractValue: async (db, projectId) =>
      (await service.contractValue(db, projectId)).currentContractValue,
    listApprovedVariations: (db, projectId) => service.listApproved(db, projectId),
  };
}

export { registerVariationsRoutes, type VariationsRouteDeps } from './routes/variations.routes.js';
export type {
  ContractValueDto,
  VariationDto,
  VariationHeaderDto,
  VariationLineDto,
} from './types.js';
