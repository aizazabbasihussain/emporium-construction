import type { Db } from '../types.js';
import { findRow, insertRow, softDeleteRow, updateRow, type Values } from './crud.js';

export interface ClaimRow {
  id: string;
  number: string;
  claimant_id: string;
  submitted_on: string | null;
  status: string;
  total: string;
  note: string;
  cancel_reason: string | null;
  version: number;
}

export interface LineRow {
  id: string;
  line_no: number;
  expense_date: string;
  category: string;
  description: string;
  cost_object_type: string;
  cost_object_id: string | null;
  cost_code_id: string;
  amount: string;
  receipt_file_id: string | null;
  cost_entry_id: string | null;
}

export interface AdvanceRow {
  id: string;
  number: string;
  custodian_id: string;
  amount: string;
  issued_on: string;
  issued_by: string;
  purpose: string;
  status: string;
  settled_on: string | null;
  settlement_note: string | null;
  version: number;
}

export interface CustodianRow {
  user_id: string;
  float_limit: string;
  active: boolean;
  version: number;
}

export interface CategoryRow {
  code: string;
  name: string;
  default_cost_code_id: string | null;
  receipt_required: boolean;
  max_without_receipt: string;
  version: number;
}

const CLAIM_COLUMNS = `id, number, claimant_id, to_char(submitted_on, 'YYYY-MM-DD') as submitted_on,
  status, total::text as total, note, cancel_reason, version`;

const LINE_COLUMNS = `id, line_no, to_char(expense_date, 'YYYY-MM-DD') as expense_date, category,
  description, cost_object_type, cost_object_id, cost_code_id, amount::text as amount,
  receipt_file_id, cost_entry_id`;

const ADVANCE_COLUMNS = `id, number, custodian_id, amount::text as amount,
  to_char(issued_on, 'YYYY-MM-DD') as issued_on, issued_by, purpose, status,
  to_char(settled_on, 'YYYY-MM-DD') as settled_on, settlement_note, version`;

const CUSTODIAN_COLUMNS = 'user_id, float_limit::text as float_limit, active, version';

const CATEGORY_COLUMNS = `code, name, default_cost_code_id, receipt_required,
  max_without_receipt::text as max_without_receipt, version`;

// ---- claims ----

export const insertClaim = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<ClaimRow>(db, 'exp_claims', CLAIM_COLUMNS, values, by, at);

/** Undefined when the claim is gone or its version moved on. */
export const updateClaim = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<ClaimRow>(db, 'exp_claims', CLAIM_COLUMNS, id, version, values, by, at);

export const softDeleteClaim = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'exp_claims', id, version, by, at);

export const findClaim = (db: Db, id: string, lock = false) =>
  findRow<ClaimRow>(db, 'exp_claims', CLAIM_COLUMNS, id, lock);

export interface ClaimSearch {
  claimantId?: string | undefined;
  status?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchClaims(
  db: Db,
  search: ClaimSearch,
): Promise<{ rows: ClaimRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (search.claimantId !== undefined) {
    params.push(search.claimantId);
    where.push(`claimant_id = $${params.length}`);
  }
  if (search.status !== undefined) {
    params.push(search.status);
    where.push(`status = $${params.length}`);
  }
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from exp_claims where ${filter}`,
    params,
  );
  const rows = await db.query<ClaimRow>(
    `select ${CLAIM_COLUMNS} from exp_claims where ${filter}
      order by created_at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

export const listLines = (db: Db, claimId: string) =>
  db.query<LineRow>(
    `select ${LINE_COLUMNS} from exp_claim_lines where claim_id = $1 order by line_no`,
    [claimId],
  );

export interface NewLine {
  id: string;
  lineNo: number;
  expenseDate: string;
  category: string;
  description: string;
  costObjectType: string;
  costObjectId: string | null;
  costCodeId: string;
  amount: string;
  receiptFileId: string | null;
}

/** The lines are replaced as a whole with the draft they belong to. */
export async function replaceLines(
  db: Db,
  claimId: string,
  lines: readonly NewLine[],
): Promise<void> {
  await db.query('delete from exp_claim_lines where claim_id = $1', [claimId]);
  for (const line of lines) {
    await db.query(
      `insert into exp_claim_lines
         (id, claim_id, line_no, expense_date, category, description, cost_object_type,
          cost_object_id, cost_code_id, amount, receipt_file_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        line.id,
        claimId,
        line.lineNo,
        line.expenseDate,
        line.category,
        line.description,
        line.costObjectType,
        line.costObjectId,
        line.costCodeId,
        line.amount,
        line.receiptFileId,
      ],
    );
  }
}

/** BR-5: remembers the latest cost entry of a line's chain. */
export async function setLineEntry(db: Db, lineId: string, entryId: string): Promise<void> {
  await db.query('update exp_claim_lines set cost_entry_id = $2 where id = $1', [lineId, entryId]);
}

export interface PriorLine {
  claim_number: string;
  line_no: number;
  expense_date: string;
  category: string;
  amount: string;
}

/**
 * BR-9: the lines of the claimant's other claims inside a date window, leaving out claims that
 * were rejected or cancelled.
 */
export const listPriorLines = (
  db: Db,
  claimantId: string,
  exceptClaimId: string,
  from: string,
  to: string,
) =>
  db.query<PriorLine>(
    `select c.number as claim_number, l.line_no,
            to_char(l.expense_date, 'YYYY-MM-DD') as expense_date, l.category,
            l.amount::text as amount
       from exp_claim_lines l join exp_claims c on c.id = l.claim_id
      where c.claimant_id = $1 and c.id <> $2 and c.deleted_at is null
        and c.status not in ('rejected', 'cancelled')
        and l.expense_date between $3 and $4
      order by c.created_at, l.line_no`,
    [claimantId, exceptClaimId, from, to],
  );

/** BR-1: what counts against a custodian: their approved and posted claims. */
export const listCountedClaims = (db: Db, claimantId: string) =>
  db.query<{ total: string; status: string }>(
    `select total::text as total, status from exp_claims
      where claimant_id = $1 and deleted_at is null and status in ('approved', 'posted')`,
    [claimantId],
  );

// ---- advances ----

export const insertAdvance = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<AdvanceRow>(db, 'exp_advances', ADVANCE_COLUMNS, values, by, at);

export const updateAdvance = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<AdvanceRow>(db, 'exp_advances', ADVANCE_COLUMNS, id, version, values, by, at);

export const findAdvance = (db: Db, id: string, lock = false) =>
  findRow<AdvanceRow>(db, 'exp_advances', ADVANCE_COLUMNS, id, lock);

export interface AdvanceSearch {
  custodianId?: string | undefined;
  status?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchAdvances(
  db: Db,
  search: AdvanceSearch,
): Promise<{ rows: AdvanceRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (search.custodianId !== undefined) {
    params.push(search.custodianId);
    where.push(`custodian_id = $${params.length}`);
  }
  if (search.status !== undefined) {
    params.push(search.status);
    where.push(`status = $${params.length}`);
  }
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from exp_advances where ${filter}`,
    params,
  );
  const rows = await db.query<AdvanceRow>(
    `select ${ADVANCE_COLUMNS} from exp_advances where ${filter}
      order by created_at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

/** BR-1: every advance of a custodian, for the balance. */
export const listAdvancesOf = (db: Db, custodianId: string) =>
  db.query<AdvanceRow>(
    `select ${ADVANCE_COLUMNS} from exp_advances
      where custodian_id = $1 and deleted_at is null order by created_at, id`,
    [custodianId],
  );

// ---- custodians ----

export async function findCustodian(db: Db, userId: string, lock = false) {
  const rows = await db.query<CustodianRow>(
    `select ${CUSTODIAN_COLUMNS} from exp_custodians where user_id = $1 ${lock ? 'for update' : ''}`,
    [userId],
  );
  return rows[0];
}

export const listCustodians = (db: Db) =>
  db.query<CustodianRow>(`select ${CUSTODIAN_COLUMNS} from exp_custodians order by user_id`);

/**
 * Registers a custodian or changes their limit and status. With `expectedVersion` the row must be at
 * that version (constitution 5.2); undefined when it moved on.
 */
export async function upsertCustodian(
  db: Db,
  input: {
    userId: string;
    floatLimit: string;
    active: boolean;
    expectedVersion?: number | undefined;
  },
  by: string,
  at: Date,
): Promise<CustodianRow | undefined> {
  const existing = await findCustodian(db, input.userId, true);
  if (existing === undefined) {
    const rows = await db.query<CustodianRow>(
      `insert into exp_custodians
         (user_id, float_limit, active, created_at, created_by, updated_at, updated_by)
       values ($1, $2, $3, $4, $5, $4, $5)
       returning ${CUSTODIAN_COLUMNS}`,
      [input.userId, input.floatLimit, input.active, at.toISOString(), by],
    );
    return rows[0];
  }
  const rows = await db.query<CustodianRow>(
    `update exp_custodians
        set float_limit = $2, active = $3, updated_at = $4, updated_by = $5, version = version + 1
      where user_id = $1 and version = $6
      returning ${CUSTODIAN_COLUMNS}`,
    [
      input.userId,
      input.floatLimit,
      input.active,
      at.toISOString(),
      by,
      input.expectedVersion ?? existing.version,
    ],
  );
  return rows[0];
}

// ---- categories ----

export const listCategories = (db: Db) =>
  db.query<CategoryRow>(`select ${CATEGORY_COLUMNS} from exp_categories order by code`);

export async function findCategory(db: Db, code: string) {
  const rows = await db.query<CategoryRow>(
    `select ${CATEGORY_COLUMNS} from exp_categories where code = $1`,
    [code],
  );
  return rows[0];
}

export async function upsertCategory(
  db: Db,
  input: {
    code: string;
    name: string;
    defaultCostCodeId: string | null;
    receiptRequired: boolean;
    maxWithoutReceipt: string;
  },
  by: string,
  at: Date,
): Promise<CategoryRow> {
  const rows = await db.query<CategoryRow>(
    `insert into exp_categories
       (code, name, default_cost_code_id, receipt_required, max_without_receipt,
        created_at, created_by, updated_at, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $6, $7)
     on conflict (code) do update
       set name = excluded.name, default_cost_code_id = excluded.default_cost_code_id,
           receipt_required = excluded.receipt_required,
           max_without_receipt = excluded.max_without_receipt,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by,
           version = exp_categories.version + 1
     returning ${CATEGORY_COLUMNS}`,
    [
      input.code,
      input.name,
      input.defaultCostCodeId,
      input.receiptRequired,
      input.maxWithoutReceipt,
      at.toISOString(),
      by,
    ],
  );
  return rows[0] as CategoryRow;
}
