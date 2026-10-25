// The only public entry point of the quotations module.
import type { Clock } from '@emporium/domain/kernel';
import type { Approvals } from '../approvals/index.js';
import type { Crm } from '../crm/index.js';
import type { Estimation } from '../estimation/index.js';
import type { Files } from '../files/index.js';
import type { MasterData } from '../masterdata/index.js';
import type { Platform } from '../platform/index.js';
import { quotationEntityType } from '@emporium/shared';
import { canAccessAcceptanceFile } from './policy/quotations.policy.js';
import { subscribeToApprovalOutcomes } from './service/approval-events.service.js';
import { createQuotationService, type QuotationService } from './service/quotations.service.js';

export interface Quotations {
  service: QuotationService;
  /** Query interface for other modules (spec P1-08 section 2). */
  getQuotation: QuotationService['summary'];
  /** The daily job of BR-5, run by the scheduler. */
  expireDue: QuotationService['expireDue'];
}

/**
 * Wires quotations on top of the kernel, estimation, approvals, CRM, master data and files. Reacts
 * to approval outcomes and registers the access rule for the client acceptance document (BR-6).
 */
export function createQuotations(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  estimation: Pick<Estimation, 'getEstimate'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
  crm: Pick<Crm, 'getLead'>;
  masterData: Pick<MasterData, 'getParty' | 'listLocations' | 'company'>;
  files: Pick<Files, 'list' | 'registerFileAccess'>;
}): Quotations {
  const service = createQuotationService(deps);
  subscribeToApprovalOutcomes({ platform: deps.platform, quotations: service });
  deps.files.registerFileAccess(
    quotationEntityType,
    async ({ actor, entityId, operation, db }) =>
      canAccessAcceptanceFile({
        permissions: actor.permissions,
        operation,
        quotationExists: await service.exists(db, entityId),
      }),
    // A client's signed acceptance is a financial document: its files are kept (BR-5 of files).
    { retainForever: true },
  );
  return {
    service,
    getQuotation: (db, id) => service.summary(db, id),
    expireDue: (tx) => service.expireDue(tx),
  };
}

export { registerQuotationsRoutes, type QuotationsRouteDeps } from './routes/quotations.routes.js';
export type { QuotationDto, QuotationHeaderDto, QuotationPrintModel, StageDto } from './types.js';
