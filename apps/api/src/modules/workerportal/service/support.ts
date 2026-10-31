import type { Platform } from '../../platform/index.js';
import type { Db } from '../types.js';

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
  return async (
    tx: Db,
    actor: { userId: string; requestId: string | null },
    change: Change,
  ): Promise<void> => {
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
