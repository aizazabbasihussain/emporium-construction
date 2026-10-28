import { stockAdjustmentDocType } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import type { CountsService } from './counts.service.js';
import type { GoodsReceivedEvent, StockService } from './stock.service.js';

interface ApprovalEventPayload {
  docType: string;
  docId: string;
}

/**
 * BR-2: a goods receipt into a store becomes stock; BR-8: a count adjustment posts when its
 * approval is decided. Handlers are idempotent; other events are ignored.
 */
export function subscribeToEvents(deps: {
  platform: Platform;
  stock: Pick<StockService, 'receiveFromGrn'>;
  counts: Pick<CountsService, 'onApprovalOutcome'>;
}): void {
  deps.platform.events.subscribe(
    'goods.received',
    async (event, tx) => {
      await deps.stock.receiveFromGrn(event.payload as GoodsReceivedEvent, tx);
    },
    'inventory.goods.received',
  );
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as ApprovalEventPayload;
        if (payload.docType === stockAdjustmentDocType) {
          await deps.counts.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `inventory.decision.${outcome}`,
    );
  }
}
