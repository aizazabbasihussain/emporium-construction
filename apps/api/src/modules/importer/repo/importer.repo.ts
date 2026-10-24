import type { ImportBatchStatus } from '@emporium/shared';
import type { RowError } from '@emporium/domain/importer';
import type { Db } from '../types.js';

export interface BatchRow {
  id: string;
  importer_code: string;
  file_name: string;
  file_hash: string;
  status: ImportBatchStatus;
  forced: boolean;
  row_count: number;
  error_count: number;
  dry_run_at: Date | null;
  committed_at: Date | null;
  created_at: Date;
  created_by: string | null;
  version: number;
}

export interface NewBatch {
  id: string;
  importerCode: string;
  fileName: string;
  fileHash: string;
  status: ImportBatchStatus;
  rowCount: number;
  errorCount: number;
  dryRunAt: Date;
  actorUserId: string;
}

interface ErrorRow {
  row_no: number;
  column_name: string;
  message: string;
}

const toRowError = (r: ErrorRow): RowError => ({
  rowNo: r.row_no,
  column: r.column_name,
  message: r.message,
});

export async function insertBatch(db: Db, batch: NewBatch): Promise<void> {
  await db.query(
    `insert into imp_batches
       (id, importer_code, file_name, file_hash, status, row_count, error_count, dry_run_at,
        created_at, updated_at, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $9, $9)`,
    [
      batch.id,
      batch.importerCode,
      batch.fileName,
      batch.fileHash,
      batch.status,
      batch.rowCount,
      batch.errorCount,
      batch.dryRunAt.toISOString(),
      batch.actorUserId,
    ],
  );
}

const CHUNK = 500;

export async function insertErrors(
  db: Db,
  batchId: string,
  errors: readonly RowError[],
): Promise<void> {
  for (let from = 0; from < errors.length; from += CHUNK) {
    const chunk = errors.slice(from, from + CHUNK);
    const params: unknown[] = [batchId];
    const values = chunk.map((error) => {
      params.push(error.rowNo, error.column, error.message);
      const n = params.length;
      return `($1, $${n - 2}, $${n - 1}, $${n})`;
    });
    await db.query(
      `insert into imp_errors (batch_id, row_no, column_name, message) values ${values.join(', ')}`,
      params,
    );
  }
}

export async function findBatch(db: Db, id: string): Promise<BatchRow | undefined> {
  const rows = await db.query<BatchRow>('select * from imp_batches where id = $1', [id]);
  return rows[0];
}

export async function listBatches(
  db: Db,
  filter: { importerCode?: string | undefined; limit: number; offset: number },
): Promise<BatchRow[]> {
  return db.query<BatchRow>(
    `select * from imp_batches
      where ($1::text is null or importer_code = $1)
      order by created_at desc, id desc
      limit $2 offset $3`,
    [filter.importerCode ?? null, filter.limit, filter.offset],
  );
}

/** Errors of a batch in row order; `limit` null returns all of them. */
export async function listErrors(
  db: Db,
  batchId: string,
  limit: number | null = null,
): Promise<RowError[]> {
  const rows = await db.query<ErrorRow>(
    `select row_no, column_name, message from imp_errors
      where batch_id = $1 order by row_no, id limit $2`,
    [batchId, limit],
  );
  return rows.map(toRowError);
}

/** Whether the importer has at least one committed batch (BR-7). */
export async function hasCommitted(db: Db, importerCode: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from imp_batches where importer_code = $1 and status = 'committed' limit 1`,
    [importerCode],
  );
  return rows.length > 0;
}

/** Whether this exact file was already committed for the importer (BR-4). */
export async function hasCommittedHash(
  db: Db,
  importerCode: string,
  fileHash: string,
): Promise<boolean> {
  const rows = await db.query(
    `select 1 from imp_batches
      where importer_code = $1 and file_hash = $2 and status = 'committed' limit 1`,
    [importerCode, fileHash],
  );
  return rows.length > 0;
}

/** Marks a dry-run-ok batch committed; false if it is no longer in that state. */
export async function markCommitted(
  db: Db,
  id: string,
  params: { forced: boolean; at: Date; actorUserId: string },
): Promise<boolean> {
  const rows = await db.query(
    `update imp_batches
        set status = 'committed', forced = $2, committed_at = $3, updated_at = $3,
            updated_by = $4, version = version + 1
      where id = $1 and status = 'dry_run_ok'
      returning id`,
    [id, params.forced, params.at.toISOString(), params.actorUserId],
  );
  return rows.length > 0;
}

/** Marks a dry-run-ok batch rolled back; a batch that is already committed is left alone. */
export async function markRolledBack(
  db: Db,
  id: string,
  params: { at: Date; actorUserId: string },
): Promise<void> {
  await db.query(
    `update imp_batches
        set status = 'rolled_back', updated_at = $2, updated_by = $3, version = version + 1
      where id = $1 and status = 'dry_run_ok'`,
    [id, params.at.toISOString(), params.actorUserId],
  );
}
