import { valuationPolicyDocType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { PoliciesService } from './policies.service.js';

interface ApprovalEventPayload {
  docType: string;
  docId: string;
  requesterId: string;
}

/**
 * BR-3: a policy becomes active when its approval request is approved, and is rejected when the
 * request is rejected, returned or cancelled. Events for other document types are ignored.
 */
export function subscribeToPolicyDecisions(deps: {
  platform: Platform;
  policies: Pick<PoliciesService, 'onApprovalOutcome'>;
}): void {
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as ApprovalEventPayload;
        if (payload.docType === valuationPolicyDocType) {
          await deps.policies.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `valuation.policy.${outcome}`,
    );
  }
}
