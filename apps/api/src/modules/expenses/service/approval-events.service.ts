import { expenseClaimDocType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { ClaimService } from './claims.service.js';

interface ApprovalEventPayload {
  docType: string;
  docId: string;
}

/**
 * BR-4 and BR-5: a claim moves when its approval request is decided. Events for other document
 * types are ignored.
 */
export function subscribeToDecisions(deps: {
  platform: Platform;
  claims: Pick<ClaimService, 'onApprovalOutcome'>;
}): void {
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as ApprovalEventPayload;
        if (payload.docType === expenseClaimDocType) {
          await deps.claims.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `expenses.decision.${outcome}`,
    );
  }
}
