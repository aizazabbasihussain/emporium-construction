// The only public entry point of the subcontracts module.
import {
  subcontractBillSource,
  subcontractCertificateDocType,
  subcontractOrderDocType,
} from '@emporium/shared';
import {
  createCertificateService,
  type CertificateService,
} from './service/certificates.service.js';
import { createContext, type SubcontractsDeps } from './service/context.js';
import { createLedgerService, type LedgerService } from './service/ledger.service.js';
import { createWorkOrderService, type WorkOrderService } from './service/work-orders.service.js';

export interface Subcontracts {
  orders: WorkOrderService;
  certificates: CertificateService;
  ledger: LedgerService;
  /** Module interfaces for other modules (spec P2-06 section 2). */
  getWorkOrder: WorkOrderService['getWorkOrder'];
  getCertifiedAmount: WorkOrderService['getCertifiedAmount'];
}

/**
 * Wires subcontracts on top of the kernel, projects (the cost ledger), master data, approvals and
 * payables (the bill source it registers). It pays nobody and works out no tax itself.
 */
export function createSubcontracts(deps: SubcontractsDeps): Subcontracts {
  const ctx = createContext(deps);
  const orders = createWorkOrderService(ctx);
  const certificates = createCertificateService(ctx, orders);
  const ledger = createLedgerService(ctx, orders);
  // BR-5: a certified certificate becomes a payables bill of the source `subcontract`.
  deps.payables.registerBillSource(subcontractBillSource, certificates.provider);
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as { docType: string; docId: string };
        if (payload.docType === subcontractOrderDocType) {
          await orders.onApprovalOutcome(outcome, payload, tx);
        } else if (payload.docType === subcontractCertificateDocType) {
          await certificates.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `subcontracts.approval.${outcome}`,
    );
  }
  return {
    orders,
    certificates,
    ledger,
    getWorkOrder: (db, id, actor) => orders.getWorkOrder(db, id, actor),
    getCertifiedAmount: (db, workOrderId) => orders.getCertifiedAmount(db, workOrderId),
  };
}

export {
  registerSubcontractsRoutes,
  type SubcontractsRouteDeps,
} from './routes/subcontracts.routes.js';
export type { SubcontractsDeps } from './service/context.js';
export type {
  BackChargeDto,
  CertificateDto,
  SubcontractorStatementDto,
  WorkOrderDto,
  WorkOrderHeaderDto,
  WorkOrderLedgerDto,
  WorkOrderVariationDto,
} from './types.js';
