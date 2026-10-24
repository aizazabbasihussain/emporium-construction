import type { Db } from '../types.js';

export interface IdempotencyRow {
  key: string;
  user_id: string;
  request_hash: string;
  response: unknown;
  status_code: number;
}

export async function findIdempotent(
  db: Db,
  key: string,
  userId: string,
): Promise<IdempotencyRow | undefined> {
  const rows = await db.query<IdempotencyRow>(
    `select key, user_id, request_hash, response, status_code
       from sys_idempotency where key = $1 and user_id = $2`,
    [key, userId],
  );
  return rows[0];
}

export async function storeIdempotent(db: Db, row: IdempotencyRow): Promise<void> {
  await db.query(
    `insert into sys_idempotency (key, user_id, request_hash, response, status_code)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [row.key, row.user_id, row.request_hash, JSON.stringify(row.response ?? null), row.status_code],
  );
}
