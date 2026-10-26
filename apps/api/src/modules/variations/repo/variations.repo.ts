import type { Db } from '../types.js';
import { findRow, insertRow, softDeleteRow, updateRow, type Values } from './crud.js';

export interface VariationRow {
  id: string;
  project_id: string;
  seq: number;
  number: string;
  title: string;
  reason: string;
  discovered_on: string;
  status: string;
  price_impact: string;
  cost_impact: string;
  client_approval_ref: string | null;
  client_approved_on: string | null;
  copied_from_id: string | null;
  version: number;
}

export interface LineRow {
  line_no: number;
  description: string;
  cost_code_id: string;
  cost_amount: string;
  price_amount: string;
}

export interface HistoryRow {
  from_status: string | null;
  to_status: string;
  at: Date;
  changed_by: string | null;
  note: string | null;
}

const COLUMNS = `id, project_id, seq, number, title, reason,
  to_char(discovered_on, 'YYYY-MM-DD') as discovered_on, status,
  price_impact::text as price_impact, cost_impact::text as cost_impact, client_approval_ref,
  to_char(client_approved_on, 'YYYY-MM-DD') as client_approved_on, copied_from_id, version`;

export const insertVariation = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<VariationRow>(db, 'var_variations', COLUMNS, values, by, at);

/** Undefined when the variation is gone or its version moved on. */
export const updateVariation = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<VariationRow>(db, 'var_variations', COLUMNS, id, version, values, by, at);

export const softDeleteVariation = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'var_variations', id, version, by, at);

export const findVariation = (db: Db, id: string, lock = false) =>
  findRow<VariationRow>(db, 'var_variations', COLUMNS, id, lock);

/** BR-1: the next number of a project, taken under a row lock inside the inserting transaction. */
export async function nextSeq(db: Db, projectId: string): Promise<number> {
  const rows = await db.query<{ last_seq: number }>(
    `insert into var_counters (project_id, last_seq) values ($1, 1)
     on conflict (project_id) do update set last_seq = var_counters.last_seq + 1
     returning last_seq`,
    [projectId],
  );
  return (rows[0] as { last_seq: number }).last_seq;
}

export interface VariationSearch {
  projectId: string;
  status?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchVariations(
  db: Db,
  search: VariationSearch,
): Promise<{ rows: VariationRow[]; total: number }> {
  const params: unknown[] = [search.projectId];
  const where = ['project_id = $1', 'deleted_at is null'];
  if (search.status !== undefined) {
    params.push(search.status);
    where.push(`status = $${params.length}`);
  }
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from var_variations where ${filter}`,
    params,
  );
  const rows = await db.query<VariationRow>(
    `select ${COLUMNS} from var_variations where ${filter}
      order by seq desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

/** BR-5: the client-approved variations of a project, oldest first. */
export const listApproved = (db: Db, projectId: string) =>
  db.query<VariationRow>(
    `select ${COLUMNS} from var_variations
      where project_id = $1 and status = 'client_approved' and deleted_at is null
      order by seq`,
    [projectId],
  );

/** BR-8: the distinct cost codes of the lines of each of the given variations. */
export const listLineCodes = (db: Db, variationIds: readonly string[]) =>
  db.query<{ variation_id: string; cost_code_id: string }>(
    `select distinct variation_id, cost_code_id from var_lines
      where variation_id = any($1::uuid[])`,
    [variationIds],
  );

export const listLines = (db: Db, variationId: string) =>
  db.query<LineRow>(
    `select line_no, description, cost_code_id, cost_amount::text as cost_amount,
            price_amount::text as price_amount
       from var_lines where variation_id = $1 order by line_no`,
    [variationId],
  );

export interface NewLine {
  id: string;
  lineNo: number;
  description: string;
  costCodeId: string;
  costAmount: string;
  priceAmount: string;
}

/** The lines are replaced as a whole with the draft they belong to. */
export async function replaceLines(
  db: Db,
  variationId: string,
  lines: readonly NewLine[],
): Promise<void> {
  await db.query('delete from var_lines where variation_id = $1', [variationId]);
  for (const line of lines) {
    await db.query(
      `insert into var_lines
         (id, variation_id, line_no, description, cost_code_id, cost_amount, price_amount)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        line.id,
        variationId,
        line.lineNo,
        line.description,
        line.costCodeId,
        line.costAmount,
        line.priceAmount,
      ],
    );
  }
}

export async function insertHistory(
  db: Db,
  entry: {
    id: string;
    variationId: string;
    from: string | null;
    to: string;
    at: Date;
    by: string | null;
    note: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into var_status_history (id, variation_id, from_status, to_status, at, changed_by, note)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.id,
      entry.variationId,
      entry.from,
      entry.to,
      entry.at.toISOString(),
      entry.by,
      entry.note,
    ],
  );
}

export const listHistory = (db: Db, variationId: string) =>
  db.query<HistoryRow>(
    `select from_status, to_status, at, changed_by, note from var_status_history
      where variation_id = $1 order by at, id`,
    [variationId],
  );
