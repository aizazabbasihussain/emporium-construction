import { invoiceDocType, scheduleDocType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { InvoiceService } from './invoices.service.js';
import type { ScheduleService } from './schedule.service.js';

interface ApprovalEventPayload {
  docType: string;
  docId: string;
  requesterId: string;
}

/**
 * The owner's decision on an invoice (BR-6) or on a manual schedule edit (BR-1). Approved moves an
 * invoice to `approved`; refused, returned or cancelled sends it back to draft and restores the old
 * schedule. Events for other document types are ignored, and a replay changes nothing.
 */
export function subscribeToDecisions(deps: {
  platform: Platform;
  invoices: Pick<InvoiceService, 'onApprovalOutcome'>;
  schedule: Pick<ScheduleService, 'onApprovalOutcome'>;
}): void {
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as ApprovalEventPayload;
        if (payload.docType === invoiceDocType) {
          await deps.invoices.onApprovalOutcome(outcome, payload, tx);
        } else if (payload.docType === scheduleDocType) {
          await deps.schedule.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `billing.approval.${outcome}`,
    );
  }
}

/** BR-1: a new project builds its schedule from the quotation; an approved variation adds a stage. */
export function subscribeToScheduleSources(deps: {
  platform: Platform;
  schedule: Pick<ScheduleService, 'sync'>;
}): void {
  const system = { userId: null, requestId: null };
  for (const type of ['project.created', 'variation.approved']) {
    deps.platform.events.subscribe(
      type,
      async (event, tx) => {
        await deps.schedule.sync(tx, (event.payload as { projectId: string }).projectId, system);
      },
      `billing.${type}`,
    );
  }
}
