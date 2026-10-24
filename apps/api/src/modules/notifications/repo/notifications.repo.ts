import type { Db } from '../types.js';

export interface NotificationRow {
  id: string;
  user_id: string;
  template: string;
  data: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

export interface ReminderRow {
  id: string;
  user_id: string;
  due_at: Date;
  template: string;
  data: Record<string, unknown>;
  sent_at: Date | null;
}

const COLUMNS = 'id, user_id, template, data, read_at, created_at';

export async function insertNotification(
  db: Db,
  row: { id: string; userId: string; template: string; data: unknown; at: Date },
): Promise<void> {
  await db.query(
    `insert into ntf_notifications (id, user_id, template, data, created_at)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [row.id, row.userId, row.template, JSON.stringify(row.data), row.at.toISOString()],
  );
}

export function listForUser(
  db: Db,
  userId: string,
  options: { unreadOnly: boolean; limit: number },
): Promise<NotificationRow[]> {
  return db.query<NotificationRow>(
    `select ${COLUMNS} from ntf_notifications
      where user_id = $1 and ($2::boolean = false or read_at is null)
      order by created_at desc, id desc
      limit $3`,
    [userId, options.unreadOnly, options.limit],
  );
}

export async function countUnread(db: Db, userId: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'select count(*)::int as n from ntf_notifications where user_id = $1 and read_at is null',
    [userId],
  );
  return (rows[0] as { n: number }).n;
}

/** BR-7: marking read is idempotent (the first read time is kept); undefined if not the user's own. */
export async function markRead(
  db: Db,
  id: string,
  userId: string,
  at: Date,
): Promise<{ row: NotificationRow; changed: boolean } | undefined> {
  const before = await db.query<NotificationRow>(
    `select ${COLUMNS} from ntf_notifications where id = $1 and user_id = $2 for update`,
    [id, userId],
  );
  const row = before[0];
  if (row === undefined) return undefined;
  if (row.read_at !== null) return { row, changed: false };
  const updated = await db.query<NotificationRow>(
    `update ntf_notifications set read_at = $2 where id = $1 returning ${COLUMNS}`,
    [id, at.toISOString()],
  );
  return { row: updated[0] as NotificationRow, changed: true };
}

export async function markAllRead(db: Db, userId: string, at: Date): Promise<number> {
  const rows = await db.query(
    `update ntf_notifications set read_at = $2
      where user_id = $1 and read_at is null returning id`,
    [userId, at.toISOString()],
  );
  return rows.length;
}

/** BR-7: deletes notifications created before the cutoff; returns how many. */
export async function deleteOlderThan(db: Db, cutoff: Date): Promise<number> {
  const rows = await db.query('delete from ntf_notifications where created_at < $1 returning id', [
    cutoff.toISOString(),
  ]);
  return rows.length;
}

export async function insertReminder(
  db: Db,
  row: { id: string; userId: string; dueAt: Date; template: string; data: unknown; at: Date },
): Promise<void> {
  await db.query(
    `insert into ntf_reminders (id, user_id, due_at, template, data, created_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      row.id,
      row.userId,
      row.dueAt.toISOString(),
      row.template,
      JSON.stringify(row.data),
      row.at.toISOString(),
    ],
  );
}

/**
 * BR-8: marks every due, unsent reminder as sent and returns them. The update is the claim: two
 * concurrent ticks cannot both see the same reminder as unsent, so each is delivered once.
 */
export function claimDueReminders(db: Db, now: Date): Promise<ReminderRow[]> {
  return db.query<ReminderRow>(
    `update ntf_reminders set sent_at = $1
      where id in (
        select id from ntf_reminders
         where sent_at is null and due_at <= $1
         order by due_at, id
         for update skip locked)
      returning id, user_id, due_at, template, data, sent_at`,
    [now.toISOString()],
  );
}
