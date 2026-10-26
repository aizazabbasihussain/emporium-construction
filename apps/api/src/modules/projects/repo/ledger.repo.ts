import type { Db } from '../types.js';

export interface EntryRow {
  id: string;
  seq: string;
  cost_object_type: string;
  cost_object_id: string | null;
  cost_code_id: string;
  amount: string;
  status: string;
  source_module: string;
  source_doc_type: string;
  source_doc_id: string;
  source_line_id: string | null;
  chain_key: string;
  entry_date: string;
  description: string;
  idempotency_key: string;
  reverses_entry_id: string | null;
  created_at: Date;
}

const ENTRY_COLUMNS = `id, seq::text as seq, cost_object_type, cost_object_id, cost_code_id,
  amount::text as amount, status, source_module, source_doc_type, source_doc_id, source_line_id,
  chain_key, to_char(entry_date, 'YYYY-MM-DD') as entry_date, description, idempotency_key,
  reverses_entry_id, created_at`;

export interface NewEntry {
  id: string;
  costObjectType: string;
  costObjectId: string | null;
  costCodeId: string;
  amount: string;
  status: string;
  sourceModule: string;
  sourceDocType: string;
  sourceDocId: string;
  sourceLineId: string | null;
  chainKey: string;
  entryDate: string;
  description: string;
  idempotencyKey: string;
  reversesEntryId: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/** The ledger is append-only: this is the only write, and the database refuses any other. */
export async function insertEntry(db: Db, entry: NewEntry): Promise<EntryRow> {
  const rows = await db.query<EntryRow>(
    `insert into prj_cost_entries
       (id, cost_object_type, cost_object_id, cost_code_id, amount, status, source_module,
        source_doc_type, source_doc_id, source_line_id, chain_key, entry_date, description,
        idempotency_key, reverses_entry_id, created_at, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     returning ${ENTRY_COLUMNS}`,
    [
      entry.id,
      entry.costObjectType,
      entry.costObjectId,
      entry.costCodeId,
      entry.amount,
      entry.status,
      entry.sourceModule,
      entry.sourceDocType,
      entry.sourceDocId,
      entry.sourceLineId,
      entry.chainKey,
      entry.entryDate,
      entry.description,
      entry.idempotencyKey,
      entry.reversesEntryId,
      entry.createdAt.toISOString(),
      entry.createdBy,
    ],
  );
  return rows[0] as EntryRow;
}

export async function findEntry(db: Db, id: string): Promise<EntryRow | undefined> {
  const rows = await db.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from prj_cost_entries where id = $1`,
    [id],
  );
  return rows[0];
}

export async function findEntryByKey(db: Db, key: string): Promise<EntryRow | undefined> {
  const rows = await db.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from prj_cost_entries where idempotency_key = $1`,
    [key],
  );
  return rows[0];
}

/** BR-6: the current row of a chain is its latest. */
export async function latestInChain(db: Db, chainKey: string): Promise<EntryRow | undefined> {
  const rows = await db.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from prj_cost_entries where chain_key = $1 order by prj_cost_entries.seq desc limit 1`,
    [chainKey],
  );
  return rows[0];
}

export interface EntryFilter {
  costObjectType: string;
  costObjectId: string | null;
  status?: string | undefined;
  costCodeId?: string | undefined;
  limit: number;
  offset: number;
}

export async function listEntries(
  db: Db,
  filter: EntryFilter,
): Promise<{ rows: EntryRow[]; total: number }> {
  const params: unknown[] = [filter.costObjectType];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['cost_object_type = $1'];
  where.push(
    filter.costObjectId === null
      ? 'cost_object_id is null'
      : `cost_object_id = ${add(filter.costObjectId)}`,
  );
  if (filter.status !== undefined) where.push(`status = ${add(filter.status)}`);
  if (filter.costCodeId !== undefined) where.push(`cost_code_id = ${add(filter.costCodeId)}`);
  const clause = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from prj_cost_entries where ${clause}`,
    params,
  );
  const limit = add(filter.limit);
  const offset = add(filter.offset);
  const rows = await db.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from prj_cost_entries where ${clause}
      order by prj_cost_entries.seq desc limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

export interface SummaryRow {
  cost_code_id: string;
  committed: string;
  approved: string;
  posted: string;
}

/** The published read view, one row per cost code (BR-7). */
export async function summaryRows(
  db: Db,
  costObjectType: string,
  costObjectId: string | null,
): Promise<SummaryRow[]> {
  return db.query<SummaryRow>(
    `select cost_code_id, committed::text as committed, approved::text as approved,
            posted::text as posted
       from prj_v_cost_summary
      where cost_object_type = $1 and cost_object_id is not distinct from $2::uuid
      order by cost_code_id`,
    [costObjectType, costObjectId],
  );
}

/** BR-4: the current rows of a project's chains that are still committed or approved. */
export async function openEntriesOf(
  db: Db,
  projectId: string,
): Promise<{ committed: string[]; unpostedApproved: string[] }> {
  const rows = await db.query<{ id: string; status: string }>(
    `select id, status from (
       select distinct on (chain_key) id, status
         from prj_cost_entries
        where cost_object_type = 'project' and cost_object_id = $1
        order by chain_key, seq desc
     ) current_entries
     where status in ('committed', 'approved')
     order by id`,
    [projectId],
  );
  return {
    committed: rows.filter((row) => row.status === 'committed').map((row) => row.id),
    unpostedApproved: rows.filter((row) => row.status === 'approved').map((row) => row.id),
  };
}
