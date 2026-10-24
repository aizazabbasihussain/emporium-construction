// The only public entry point of the approvals module.
import type { Clock } from '@emporium/domain/kernel';
import type { Platform } from '../platform/index.js';
import { createApprovalsService, type ApprovalsService } from './service/approvals.service.js';
import { createRulesService, type RulesService } from './service/rules.service.js';
import type { Db } from './types.js';

export interface Approvals {
  service: ApprovalsService;
  rules: RulesService;
  /** Module-to-module API (spec P1-03 section 2); call it inside the owning module's transaction. */
  requestApproval: ApprovalsService['requestApproval'];
  getApprovalState: ApprovalsService['getApprovalState'];
  cancelApproval: ApprovalsService['cancelApproval'];
}

/** Wires approvals on top of the kernel. Other modules receive the returned object. */
export function createApprovals(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  /** Codes of the existing roles (identity owns them), used to validate rule steps. */
  roleCodes: (db: Db) => Promise<string[]>;
}): Approvals {
  const service = createApprovalsService(deps);
  return {
    service,
    rules: createRulesService(deps),
    requestApproval: (input, tx) => service.requestApproval(input, tx),
    getApprovalState: (db, docType, docId) => service.getApprovalState(db, docType, docId),
    cancelApproval: (input, tx) => service.cancelApproval(input, tx),
  };
}

export { registerApprovalsRoutes, type ApprovalsRouteDeps } from './routes/approvals.routes.js';
export type {
  ApprovalState,
  RequestApprovalInput,
  RequestDto,
  RuleSetDto,
  RuleSetInput,
} from './types.js';
