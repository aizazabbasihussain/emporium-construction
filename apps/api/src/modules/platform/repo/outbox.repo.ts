import type { Db } from '../types.js';

export interface OutboxRow {
  id: string;
  type: string;
  payload: unknown;
  occurred_at: Date;
  dispatched_at: Date | null;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  failed_at: Date | null;
}

export async function insertEvent(
  db: Db,
  event: { id: string; type: string; payload: unknown; occurredAt: Date },
): Promise<void> {
  await db.query(
    `insert into sys_outbox (id, type, payload, occurred_at, next_attempt_at)
     values ($1, $2, $3::jsonb, $4, $4)`,
    [event.id, event.type, JSON.stringify(event.payload ?? null), event.occurredAt.toISOString()],
  );
}

export async function findDue(db: Db, now: Date, limit: number): Promise<OutboxRow[]> {
  return db.query<OutboxRow>(
    `select * from sys_outbox
      where dispatched_at is null and failed_at is null and next_attempt_at <= $1
      order by occurred_at, id
      limit $2`,
    [now.toISOString(), limit],
  );
}

/** Records that `handler` consumed the event; false when it had already done so (replay-safe). */
export async function consume(db: Db, eventId: string, handler: string): Promise<boolean> {
  const rows = await db.query(
    `insert into sys_event_consumptions (event_id, handler) values ($1, $2)
     on conflict (event_id, handler) do nothing
     returning event_id`,
    [eventId, handler],
  );
  return rows.length > 0;
}

export async function markDispatched(db: Db, eventId: string, now: Date): Promise<void> {
  await db.query('update sys_outbox set dispatched_at = $2 where id = $1', [
    eventId,
    now.toISOString(),
  ]);
}

export async function recordAttempt(
  db: Db,
  eventId: string,
  attempt: { attempts: number; nextAttemptAt: Date; error: string; failedAt: Date | null },
): Promise<void> {
  await db.query(
    `update sys_outbox
        set attempts = $2, next_attempt_at = $3, last_error = $4, failed_at = $5
      where id = $1`,
    [
      eventId,
      attempt.attempts,
      attempt.nextAttemptAt.toISOString(),
      attempt.error,
      attempt.failedAt?.toISOString() ?? null,
    ],
  );
}

export async function listFailed(db: Db): Promise<OutboxRow[]> {
  return db.query<OutboxRow>(
    'select * from sys_outbox where failed_at is not null order by failed_at desc, id',
  );
}

/** Re-queues a failed event; undefined when the event is missing or not failed. */
export async function requeueFailed(
  db: Db,
  eventId: string,
  now: Date,
): Promise<OutboxRow | undefined> {
  const rows = await db.query<OutboxRow>(
    `update sys_outbox
        set failed_at = null, attempts = 0, next_attempt_at = $2, last_error = null
      where id = $1 and failed_at is not null
      returning *`,
    [eventId, now.toISOString()],
  );
  return rows[0];
}

export async function findEvent(db: Db, eventId: string): Promise<OutboxRow | undefined> {
  const rows = await db.query<OutboxRow>('select * from sys_outbox where id = $1', [eventId]);
  return rows[0];
}
