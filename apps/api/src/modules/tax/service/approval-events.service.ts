import { taxRuleDocType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { RulesService } from './rules.service.js';

interface ApprovalEventPayload {
  docType: string;
  docId: string;
  requesterId: string;
}

/**
 * BR-6: a rule becomes active when its approval request is approved, and is rejected when the
 * request is rejected, returned or cancelled. Events for other document types are ignored.
 */
export function subscribeToRuleDecisions(deps: {
  platform: Platform;
  rules: Pick<RulesService, 'onApprovalOutcome'>;
}): void {
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as ApprovalEventPayload;
        if (payload.docType === taxRuleDocType) {
          await deps.rules.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `tax.rule.${outcome}`,
    );
  }
}
