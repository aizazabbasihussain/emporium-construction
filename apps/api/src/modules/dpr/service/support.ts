import type { Platform } from '../../platform/index.js';
import type { Db } from '../types.js';

/** An event handler or a scheduled job acts as the system: no user. */
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

/** Empty text becomes null; other text is trimmed. */
export const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};
