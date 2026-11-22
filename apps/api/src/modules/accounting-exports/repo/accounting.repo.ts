import type { Db } from '../types.js';

/* ------------------------------------------------------------------ accounts */

export interface AccountRow {
  code: string;
  name: string;
  type: string;
  parent_code: string | null;
  active: boolean;
  version: number;
}

const ACCOUNT_COLUMNS = 'code, name, type, parent_code, active, version';

export const listAccounts = (db: Db, includeInactive: boolean) =>
  db.query<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from acc_accounts where ($1::boolean or active) order by code`,
    [includeInactive],
  );

export async function findAccount(db: Db, code: string): Promise<AccountRow | undefined> {
  const rows = await db.query<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from acc_accounts where code = $1`,
    [code],
  );
  return rows[0];
}

/** Undefined when the account is gone or its version moved on. */
export async function setAccountActive(
  db: Db,
  code: string,
  version: number,
  active: boolean,
  by: string | null,
  at: Date,
): Promise<AccountRow | undefined> {
  const rows = await db.query<AccountRow>(
    `update acc_accounts set active = $3, updated_at = $4, updated_by = $5, version = version + 1
      where code = $1 and version = $2 returning ${ACCOUNT_COLUMNS}`,
    [code, version, active, at.toISOString(), by],
  );
  return rows[0];
}

/* ------------------------------------------------------------------ mapping rules */

export interface RuleRow {
  id: string;
  source_doc_type: string;
  condition: Record<string, string>;
  debit_account_code: string;
  credit_account_code: string;
  effective_from: string;
  active: boolean;
  version: number;
}

const RULE_COLUMNS = `id, source_doc_type, condition, debit_account_code, credit_account_code,
  effective_from::text as effective_from, active, version`;

export const listRules = (db: Db) =>
  db.query<RuleRow>(
    `select ${RULE_COLUMNS} from acc_mapping_rules where deleted_at is null
      order by source_doc_type, effective_from desc, id`,
  );

export async function findRule(db: Db, id: string): Promise<RuleRow | undefined> {
  const rows = await db.query<RuleRow>(
    `select ${RULE_COLUMNS} from acc_mapping_rules where id = $1 and deleted_at is null`,
    [id],
  );
  return rows[0];
}

export interface RuleValues {
  sourceDocType: string;
  condition: Record<string, string>;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveFrom: string;
  active: boolean;
}

export async function insertRule(
  db: Db,
  id: string,
  values: RuleValues,
  by: string | null,
  at: Date,
): Promise<RuleRow> {
  const rows = await db.query<RuleRow>(
    `insert into acc_mapping_rules
       (id, source_doc_type, condition, debit_account_code, credit_account_code, effective_from,
        active, created_at, created_by, updated_at, updated_by)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $8, $9)
     returning ${RULE_COLUMNS}`,
    [
      id,
      values.sourceDocType,
      JSON.stringify(values.condition),
      values.debitAccountCode,
      values.creditAccountCode,
      values.effectiveFrom,
      values.active,
      at.toISOString(),
      by,
    ],
  );
  return rows[0] as RuleRow;
}

/** Undefined when the rule is gone or its version moved on. */
export async function updateRule(
  db: Db,
  id: string,
  version: number,
  values: RuleValues,
  by: string | null,
  at: Date,
): Promise<RuleRow | undefined> {
  const rows = await db.query<RuleRow>(
    `update acc_mapping_rules
        set source_doc_type = $3, condition = $4::jsonb, debit_account_code = $5,
            credit_account_code = $6, effective_from = $7, active = $8,
            updated_at = $9, updated_by = $10, version = version + 1
      where id = $1 and version = $2 and deleted_at is null
      returning ${RULE_COLUMNS}`,
    [
      id,
      version,
      values.sourceDocType,
      JSON.stringify(values.condition),
      values.debitAccountCode,
      values.creditAccountCode,
      values.effectiveFrom,
      values.active,
      at.toISOString(),
      by,
    ],
  );
  return rows[0];
}

/* ------------------------------------------------------------------ tags */

export interface TagRow {
  source_doc_type: string;
  source_doc_id: string;
  line_ref: string;
  account_code: string;
  tagged_by: string | null;
  method: string;
  tagged_at: Date;
}

const TAG_COLUMNS =
  'source_doc_type, source_doc_id, line_ref, account_code, tagged_by, method, tagged_at';

/** One tag per line: a later tag replaces the earlier one (the accountant changing it). */
export async function upsertTag(
  db: Db,
  tag: {
    docType: string;
    docId: string;
    lineRef: string;
    accountCode: string;
    by: string | null;
    method: string;
  },
  at: Date,
): Promise<TagRow> {
  const rows = await db.query<TagRow>(
    `insert into acc_tags (source_doc_type, source_doc_id, line_ref, account_code, tagged_by, method, tagged_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (source_doc_type, source_doc_id, line_ref)
     do update set account_code = excluded.account_code, tagged_by = excluded.tagged_by,
                   method = excluded.method, tagged_at = excluded.tagged_at
     returning ${TAG_COLUMNS}`,
    [tag.docType, tag.docId, tag.lineRef, tag.accountCode, tag.by, tag.method, at.toISOString()],
  );
  return rows[0] as TagRow;
}

export async function findTag(
  db: Db,
  docType: string,
  docId: string,
  lineRef: string,
): Promise<TagRow | undefined> {
  const rows = await db.query<TagRow>(
    `select ${TAG_COLUMNS} from acc_tags
      where source_doc_type = $1 and source_doc_id = $2 and line_ref = $3`,
    [docType, docId, lineRef],
  );
  return rows[0];
}

/** Writes a rule tag only when the line has none; true when it was written (BR-9). */
export async function insertTagIfAbsent(
  db: Db,
  tag: { docType: string; docId: string; lineRef: string; accountCode: string; by: string | null },
  at: Date,
): Promise<boolean> {
  const rows = await db.query<{ source_doc_id: string }>(
    `insert into acc_tags (source_doc_type, source_doc_id, line_ref, account_code, tagged_by, method, tagged_at)
     values ($1, $2, $3, $4, $5, 'rule', $6)
     on conflict (source_doc_type, source_doc_id, line_ref) do nothing
     returning source_doc_id`,
    [tag.docType, tag.docId, tag.lineRef, tag.accountCode, tag.by, at.toISOString()],
  );
  return rows.length > 0;
}

/** The tags of the given documents of one type (the export's account_code column). */
export const listTagsOfDocs = (db: Db, docType: string, docIds: string[]) =>
  db.query<TagRow>(
    `select ${TAG_COLUMNS} from acc_tags where source_doc_type = $1 and source_doc_id = any($2::text[])`,
    [docType, docIds],
  );

/** Every tagged line, as `type|id|line` keys, for finding the untagged ones. */
export async function listTaggedKeys(db: Db): Promise<Set<string>> {
  const rows = await db.query<{ k: string }>(
    `select source_doc_type || '|' || source_doc_id || '|' || line_ref as k from acc_tags`,
  );
  return new Set(rows.map((row) => row.k));
}

/* ------------------------------------------------------------------ export runs */

export interface RunRow {
  id: string;
  export_code: string;
  schema_version: number;
  filters: Record<string, string>;
  row_count: number;
  checksum_sha256: string;
  file_id: string | null;
  run_by: string | null;
  run_at: Date;
}

const RUN_COLUMNS =
  'id, export_code, schema_version, filters, row_count, checksum_sha256, file_id, run_by, run_at';

export async function insertRun(
  db: Db,
  run: {
    id: string;
    exportCode: string;
    schemaVersion: number;
    filters: Record<string, string>;
    rowCount: number;
    checksum: string;
    fileId: string | null;
    by: string | null;
  },
  at: Date,
): Promise<RunRow> {
  const rows = await db.query<RunRow>(
    `insert into acc_export_runs
       (id, export_code, schema_version, filters, row_count, checksum_sha256, file_id, run_by, run_at)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
     returning ${RUN_COLUMNS}`,
    [
      run.id,
      run.exportCode,
      run.schemaVersion,
      JSON.stringify(run.filters),
      run.rowCount,
      run.checksum,
      run.fileId,
      run.by,
      at.toISOString(),
    ],
  );
  return rows[0] as RunRow;
}

export async function listRuns(
  db: Db,
  query: { exportCode?: string | undefined; limit: number; offset: number },
): Promise<{ rows: RunRow[]; total: number }> {
  const params = [query.exportCode ?? null];
  const rows = await db.query<RunRow>(
    `select ${RUN_COLUMNS} from acc_export_runs where ($1::text is null or export_code = $1)
      order by run_at desc, id desc limit $2 offset $3`,
    [...params, query.limit, query.offset],
  );
  const [count] = await db.query<{ n: string }>(
    'select count(*) as n from acc_export_runs where ($1::text is null or export_code = $1)',
    params,
  );
  return { rows, total: Number(count?.n ?? 0) };
}
