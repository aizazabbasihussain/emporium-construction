import type { Db } from '../types.js';

export interface SavedFilterRow {
  id: string;
  user_id: string;
  report_code: string;
  name: string;
  filter: Record<string, unknown>;
  version: number;
}

const COLUMNS = 'id, user_id, report_code, name, filter, version';

export async function insertSavedFilter(
  db: Db,
  row: { id: string; userId: string; reportCode: string; name: string; filter: unknown },
  at: Date,
): Promise<SavedFilterRow> {
  const rows = await db.query<SavedFilterRow>(
    `insert into rpt_saved_filters
       (id, user_id, report_code, name, filter, created_at, created_by, updated_at, updated_by)
     values ($1, $2, $3, $4, $5::jsonb, $6, $2, $6, $2)
     returning ${COLUMNS}`,
    [row.id, row.userId, row.reportCode, row.name, JSON.stringify(row.filter), at.toISOString()],
  );
  return rows[0] as SavedFilterRow;
}

export async function findSavedFilter(db: Db, id: string): Promise<SavedFilterRow | undefined> {
  const rows = await db.query<SavedFilterRow>(
    `select ${COLUMNS} from rpt_saved_filters where id = $1 and deleted_at is null`,
    [id],
  );
  return rows[0];
}

export async function findSavedFilterByName(
  db: Db,
  userId: string,
  reportCode: string,
  name: string,
): Promise<SavedFilterRow | undefined> {
  const rows = await db.query<SavedFilterRow>(
    `select ${COLUMNS} from rpt_saved_filters
      where user_id = $1 and report_code = $2 and lower(name) = lower($3) and deleted_at is null`,
    [userId, reportCode, name],
  );
  return rows[0];
}

export const listSavedFilters = (db: Db, userId: string, reportCode: string | null) =>
  db.query<SavedFilterRow>(
    `select ${COLUMNS} from rpt_saved_filters
      where user_id = $1 and ($2::text is null or report_code = $2) and deleted_at is null
      order by report_code, lower(name)`,
    [userId, reportCode],
  );

/** Undefined when the filter is gone or its version moved on. */
export async function softDeleteSavedFilter(
  db: Db,
  id: string,
  version: number,
  by: string,
  at: Date,
): Promise<boolean> {
  const rows = await db.query(
    `update rpt_saved_filters
        set deleted_at = $1, updated_at = $1, updated_by = $2, version = version + 1
      where id = $3 and version = $4 and deleted_at is null
      returning id`,
    [at.toISOString(), by, id, version],
  );
  return rows.length === 1;
}

export interface ClientMaterialRow {
  project_id: string;
  item_id: string;
  owner_party_id: string;
  received_qty: string;
  used_qty: string;
  returned_qty: string;
  balance_qty: string;
}

/**
 * BR-7: reads the published view `inv_v_client_material_balance` of the inventory module, adding
 * the stores up so each item of a client shows once per project.
 */
export function listClientMaterialRows(
  db: Db,
  filter: { projectId: string | null; projectIds: readonly string[] | null },
): Promise<ClientMaterialRow[]> {
  return db.query<ClientMaterialRow>(
    `select project_id, item_id, owner_party_id, sum(received_qty)::text as received_qty,
            sum(used_qty)::text as used_qty, sum(returned_qty)::text as returned_qty,
            sum(balance_qty)::text as balance_qty
       from inv_v_client_material_balance
      where ($1::uuid is null or project_id = $1)
        and ($2::uuid[] is null or project_id = any($2))
      group by project_id, item_id, owner_party_id
      order by project_id, item_id, owner_party_id`,
    [filter.projectId, filter.projectIds === null ? null : [...filter.projectIds]],
  );
}
