import { attendanceSheetDocType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { SheetsService } from './sheets.service.js';

interface ApprovalEventPayload {
  docType: string;
  docId: string;
}

/**
 * BR-6 and BR-8: a sheet moves when its approval request is decided. Events for other document
 * types are ignored.
 */
export function subscribeToDecisions(deps: {
  platform: Platform;
  sheets: Pick<SheetsService, 'onApprovalOutcome'>;
}): void {
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as ApprovalEventPayload;
        if (payload.docType === attendanceSheetDocType) {
          await deps.sheets.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `attendance.decision.${outcome}`,
    );
  }
}
