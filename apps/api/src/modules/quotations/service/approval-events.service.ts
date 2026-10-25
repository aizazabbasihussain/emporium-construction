import { quotationDocType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { ApprovalOutcomePayload, QuotationService } from './quotations.service.js';

/**
 * BR-2: a quotation becomes approved when its approval request is approved, and goes back to draft
 * when the request is rejected, returned or cancelled. Events for other document types are ignored.
 */
export function subscribeToApprovalOutcomes(deps: {
  platform: Platform;
  quotations: Pick<QuotationService, 'onApprovalOutcome'>;
}): void {
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as ApprovalOutcomePayload;
        if (payload.docType === quotationDocType) {
          await deps.quotations.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `quotations.approval.${outcome}`,
    );
  }
}
