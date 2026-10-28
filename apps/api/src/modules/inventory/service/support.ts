import { ValidationError } from '@emporium/domain';
import type { Platform } from '../../platform/index.js';
import type { LedgerRow } from '../repo/inventory.repo.js';
import type { Ownership } from '@emporium/shared';
import type { Db, LedgerDto } from '../types.js';

/** Who a change is recorded against; the event handlers act as the system (no user). */
export interface Recorded {
  userId: string | null;
  requestId: string | null;
}

export interface Change {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** Published to the outbox in the same transaction (constitution 5.9). */
  event: { type: string; payload: unknown };
}

/** Every change writes an audit entry and an event. */
export function createRecorder(platform: Platform) {
  return async (tx: Db, actor: Recorded, change: Change): Promise<void> => {
    await platform.audit.record(
      {
        actorUserId: actor.userId,
        action: change.action,
        entityType: change.entityType,
        entityId: change.entityId,
        before: change.before,
        after: change.after,
        requestId: actor.requestId,
      },
      tx,
    );
    await platform.events.publish(change.event, tx);
  };
}

export const ledgerDtoOf = (row: LedgerRow): LedgerDto => ({
  id: row.id,
  seq: Number(row.seq),
  storeId: row.store_id,
  itemId: row.item_id,
  ownership: row.ownership as Ownership,
  ownerPartyId: row.owner_party_id,
  movementType: row.movement_type as LedgerDto['movementType'],
  quantity: row.quantity,
  unitCost: row.unit_cost,
  value: row.value,
  costObjectType: row.cost_object_type,
  costObjectId: row.cost_object_id,
  sourceDocType: row.source_doc_type,
  sourceDocId: row.source_doc_id,
  sourceLineId: row.source_line_id,
  businessDate: row.business_date,
  postedAt: row.posted_at,
  reversesId: row.reverses_id,
});

export function pageOf<T>(
  rows: T[],
  total: number,
  page: { limit: number; offset: number },
): { items: T[]; total: number; limit: number; offset: number } {
  return { items: rows, total, limit: page.limit, offset: page.offset };
}

/** Empty text becomes null; other text is trimmed. */
export const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

export function requiredText(value: string | null | undefined, field: string): string {
  const text = textOrNull(value);
  if (text === null) throw new ValidationError(`${field}_required`, `${field} is required`);
  return text;
}
