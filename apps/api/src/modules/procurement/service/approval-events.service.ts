import { purchaseOrderDocType, requisitionDocType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { OrderService } from './orders.service.js';
import type { RequisitionService } from './requisitions.service.js';

interface ApprovalEventPayload {
  docType: string;
  docId: string;
  requesterId: string;
}

/**
 * BR-1 and BR-4: a requisition or purchase order moves when its approval request is decided. Events
 * for other document types are ignored.
 */
export function subscribeToDecisions(deps: {
  platform: Platform;
  requisitions: Pick<RequisitionService, 'onApprovalOutcome'>;
  orders: Pick<OrderService, 'onApprovalOutcome'>;
}): void {
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as ApprovalEventPayload;
        if (payload.docType === requisitionDocType) {
          await deps.requisitions.onApprovalOutcome(outcome, payload, tx);
        } else if (payload.docType === purchaseOrderDocType) {
          await deps.orders.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `procurement.decision.${outcome}`,
    );
  }
}
