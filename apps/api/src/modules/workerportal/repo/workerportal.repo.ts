import type { Db } from '../types.js';

export interface AccountRow {
  user_id: string;
  worker_id: string;
  linked_by: string;
  linked_at: string;
}

const COLUMNS = 'user_id, worker_id, linked_by, linked_at::text as linked_at';

export async function findAccountOfUser(db: Db, userId: string): Promise<AccountRow | undefined> {
  const rows = await db.query<AccountRow>(
    `select ${COLUMNS} from wkp_worker_accounts where user_id = $1`,
    [userId],
  );
  return rows[0];
}

/** Locked, so two admins linking the same worker at once take turns. */
export async function findAccountOfWorker(
  db: Db,
  workerId: string,
  lock = false,
): Promise<AccountRow | undefined> {
  const rows = await db.query<AccountRow>(
    `select ${COLUMNS} from wkp_worker_accounts where worker_id = $1 ${lock ? 'for update' : ''}`,
    [workerId],
  );
  return rows[0];
}

export async function insertAccount(
  db: Db,
  row: { userId: string; workerId: string; linkedBy: string; linkedAt: Date },
): Promise<AccountRow> {
  const rows = await db.query<AccountRow>(
    `insert into wkp_worker_accounts (user_id, worker_id, linked_by, linked_at)
     values ($1, $2, $3, $4)
     returning ${COLUMNS}`,
    [row.userId, row.workerId, row.linkedBy, row.linkedAt.toISOString()],
  );
  return rows[0] as AccountRow;
}

export async function deleteAccountOfWorker(db: Db, workerId: string): Promise<void> {
  await db.query('delete from wkp_worker_accounts where worker_id = $1', [workerId]);
}
