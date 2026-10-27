import { createCommitments } from './commitments.js';
import { createContext, type ProcurementDeps } from './context.js';
import { createOrderService } from './orders.service.js';
import { createReceiptService } from './receipts.service.js';
import { createRequisitionService } from './requisitions.service.js';
import { createRfqService } from './rfq.service.js';

/** The four parts of the module, wired to one set of dependencies. */
export function createProcurementService(deps: ProcurementDeps) {
  const ctx = createContext(deps);
  const commitments = createCommitments(ctx);
  const requisitions = createRequisitionService(ctx);
  return {
    requisitions,
    rfqs: createRfqService(ctx),
    orders: createOrderService(ctx, requisitions, commitments),
    receipts: createReceiptService(ctx, commitments),
  };
}

export type ProcurementService = ReturnType<typeof createProcurementService>;
