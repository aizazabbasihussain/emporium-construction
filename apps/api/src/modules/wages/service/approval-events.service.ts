import { wagePeriodDocType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { PeriodsService } from './periods.service.js';

interface ApprovalEventPayload {
  docType: string;
  docId: string;
}

/**
 * BR-11: a period moves when its approval request is decided. Events for other document types are
 * ignored.
 */
export function subscribeToDecisions(deps: {
  platform: Platform;
  periods: Pick<PeriodsService, 'onApprovalOutcome'>;
}): void {
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as ApprovalEventPayload;
        if (payload.docType === wagePeriodDocType) {
          await deps.periods.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `wages.decision.${outcome}`,
    );
  }
}
