import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

const DATE = (column: string) => `to_char(${column}, 'YYYY-MM-DD') as ${column}`;
const countOf = (rows: { total: string }[]): number => Number(rows[0]?.total ?? 0);

/* ------------------------------------------------------------------ stores */

const STORE_COLUMNS = 'id, code, name, kind, project_id, custodian_user_id, active, version';

export interface StoreRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  project_id: string | null;
  custodian_user_id: string | null;
  active: boolean;
  version: number;
}

export const insertStore = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<StoreRow>(db, 'inv_stores', STORE_COLUMNS, values, by, at);

export const findStore = (db: Db, id: string, lock = false) =>
  findRow<StoreRow>(db, 'inv_stores', STORE_COLUMNS, id, lock);

export async function findStoreByCode(db: Db, code: string): Promise<StoreRow | undefined> {
  const rows = await db.query<StoreRow>(
    `select ${STORE_COLUMNS} from inv_stores where code = $1 and deleted_at is null`,
    [code],
  );
  return rows[0];
}

export interface StoreSearch {
  projectIds?: readonly string[] | undefined;
  active?: boolean | undefined;
  limit: number;
  offset: number;
}

export async function searchStores(
  db: Db,
  search: StoreSearch,
): Promise<{ rows: StoreRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (search.projectIds !== undefined) {
    params.push(search.projectIds);
    where.push(`project_id = any($${params.length}::uuid[])`);
  }
  if (search.active !== undefined) {
    params.push(search.active);
    where.push(`active = $${params.length}`);
  }
  const clause = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from inv_stores where ${clause}`,
    params,
  );
  params.push(search.limit, search.offset);
  const rows = await db.query<StoreRow>(
    `select ${STORE_COLUMNS} from inv_stores where ${clause}
      order by code, id limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { rows, total: countOf(total) };
}

/* ---------------------------------------------------------------- balances */

export interface BalanceRow {
  id: string;
  store_id: string;
  item_id: string;
  ownership: string;
  owner_party_id: string | null;
  quantity: string;
}

const BALANCE_COLUMNS =
  'id, store_id, item_id, ownership, owner_party_id, quantity::text as quantity';
const NO_OWNER = "'00000000-0000-0000-0000-000000000000'::uuid";

export interface BalanceKey {
  storeId: string;
  itemId: string;
  ownership: string;
  ownerPartyId: string | null;
}

/** BR-11: creates the balance row if needed and locks it, so two movements of a key queue up. */
export async function lockBalance(
  db: Db,
  id: string,
  key: BalanceKey,
  at: Date,
): Promise<BalanceRow> {
  await db.query(
    `insert into inv_balances (id, store_id, item_id, ownership, owner_party_id, quantity, updated_at)
     values ($1, $2, $3, $4, $5, 0, $6)
     on conflict (store_id, item_id, ownership, coalesce(owner_party_id, ${NO_OWNER})) do nothing`,
    [id, key.storeId, key.itemId, key.ownership, key.ownerPartyId, at.toISOString()],
  );
  const rows = await db.query<BalanceRow>(
    `select ${BALANCE_COLUMNS} from inv_balances
      where store_id = $1 and item_id = $2 and ownership = $3
        and coalesce(owner_party_id, ${NO_OWNER}) = coalesce($4::uuid, ${NO_OWNER})
        for update`,
    [key.storeId, key.itemId, key.ownership, key.ownerPartyId],
  );
  return rows[0] as BalanceRow;
}

export async function setBalance(db: Db, id: string, quantity: string, at: Date): Promise<void> {
  await db.query('update inv_balances set quantity = $1, updated_at = $2 where id = $3', [
    quantity,
    at.toISOString(),
    id,
  ]);
}

export interface StockSearch {
  projectIds?: readonly string[] | undefined;
  storeId?: string | undefined;
  itemId?: string | undefined;
  ownership?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchStock(
  db: Db,
  search: StockSearch,
): Promise<{ rows: BalanceRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['true'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (search.projectIds !== undefined) {
    add(
      'store_id in (select id from inv_stores where project_id = any(?::uuid[]))',
      search.projectIds,
    );
  }
  if (search.storeId !== undefined) add('store_id = ?', search.storeId);
  if (search.itemId !== undefined) add('item_id = ?', search.itemId);
  if (search.ownership !== undefined) add('ownership = ?', search.ownership);
  const clause = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from inv_balances where ${clause}`,
    params,
  );
  params.push(search.limit, search.offset);
  const rows = await db.query<BalanceRow>(
    `select ${BALANCE_COLUMNS} from inv_balances where ${clause}
      order by store_id, item_id, ownership, owner_party_id, id
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { rows, total: countOf(total) };
}

export interface StockFilter {
  /** Limits the rows to the stores of these projects (a scope-limited caller). */
  projectIds?: readonly string[] | undefined;
  storeId?: string | undefined;
  itemId?: string | undefined;
  ownership?: string | undefined;
}

function stockClause(filter: StockFilter, column: (name: string) => string) {
  const params: unknown[] = [];
  const where = ['true'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.projectIds !== undefined) {
    add(
      `${column('store_id')} in (select id from inv_stores where project_id = any(?::uuid[]))`,
      filter.projectIds,
    );
  }
  if (filter.storeId !== undefined) add(`${column('store_id')} = ?`, filter.storeId);
  if (filter.itemId !== undefined) add(`${column('item_id')} = ?`, filter.itemId);
  if (filter.ownership !== undefined) add(`${column('ownership')} = ?`, filter.ownership);
  return { where: where.join(' and '), params };
}

export interface NamedBalanceRow extends BalanceRow {
  store_code: string;
  store_name: string;
}

/** P1-19 BR-2: every balance that matches, with its store, without paging. */
export function listBalances(db: Db, filter: StockFilter): Promise<NamedBalanceRow[]> {
  const { where, params } = stockClause(filter, (name) => `b.${name}`);
  return db.query<NamedBalanceRow>(
    `select b.id, b.store_id, b.item_id, b.ownership, b.owner_party_id,
            b.quantity::text as quantity, s.code as store_code, s.name as store_name
       from inv_balances b join inv_stores s on s.id = b.store_id
      where ${where}
      order by s.code, b.item_id, b.ownership, b.owner_party_id, b.id`,
    params,
  );
}

export interface BelowReorderRow {
  store_code: string;
  store_name: string;
  store_id: string;
  item_id: string;
  level: string;
  quantity: string;
}

/**
 * P1-19 BR-2: the company stock below its reorder level. An item with a level and no balance row
 * has nothing in the store, so it counts as zero.
 */
export function listBelowReorderRows(db: Db, filter: StockFilter): Promise<BelowReorderRow[]> {
  const { where, params } = stockClause(
    { projectIds: filter.projectIds, storeId: filter.storeId, itemId: filter.itemId },
    (name) => `l.${name}`,
  );
  return db.query<BelowReorderRow>(
    `select l.store_id, s.code as store_code, s.name as store_name, l.item_id,
            l.level::text as level, coalesce(b.quantity, 0)::text as quantity
       from inv_reorder_levels l
       join inv_stores s on s.id = l.store_id
       left join inv_balances b on b.store_id = l.store_id and b.item_id = l.item_id
                               and b.ownership = 'company'
      where ${where} and coalesce(b.quantity, 0) < l.level
      order by s.code, l.item_id`,
    params,
  );
}

/** What the balances of company stock add up to in one store and item. */
export async function balanceOf(db: Db, key: BalanceKey): Promise<string> {
  const rows = await db.query<{ quantity: string }>(
    `select quantity::text as quantity from inv_balances
      where store_id = $1 and item_id = $2 and ownership = $3
        and coalesce(owner_party_id, ${NO_OWNER}) = coalesce($4::uuid, ${NO_OWNER})`,
    [key.storeId, key.itemId, key.ownership, key.ownerPartyId],
  );
  return rows[0]?.quantity ?? '0.0000';
}

/** BR-12: balances against the signed sum of the ledger, differences only. */
export async function integrityRows(db: Db): Promise<{
  checked: number;
  differences: {
    store_id: string;
    item_id: string;
    ownership: string;
    owner_party_id: string | null;
    balance: string;
    ledger_sum: string;
  }[];
}> {
  const rows = await db.query<{
    store_id: string;
    item_id: string;
    ownership: string;
    owner_party_id: string | null;
    balance: string;
    ledger_sum: string;
  }>(
    `with ledger as (
       select store_id, item_id, ownership, owner_party_id, sum(quantity) as total
         from inv_ledger group by store_id, item_id, ownership, owner_party_id),
     keyed as (
       select coalesce(b.store_id, l.store_id) as store_id, coalesce(b.item_id, l.item_id) as item_id,
              coalesce(b.ownership, l.ownership) as ownership,
              coalesce(b.owner_party_id, l.owner_party_id) as owner_party_id,
              coalesce(b.quantity, 0) as balance, coalesce(l.total, 0) as ledger_sum
         from inv_balances b
         full join ledger l on l.store_id = b.store_id and l.item_id = b.item_id
          and l.ownership = b.ownership
          and coalesce(l.owner_party_id, ${NO_OWNER}) = coalesce(b.owner_party_id, ${NO_OWNER}))
     select store_id, item_id, ownership, owner_party_id, balance::text as balance,
            ledger_sum::text as ledger_sum
       from keyed order by store_id, item_id, ownership, owner_party_id`,
  );
  return {
    checked: rows.length,
    differences: rows.filter((row) => Number(row.balance) !== Number(row.ledger_sum)),
  };
}

/* ------------------------------------------------------------------ ledger */

const LEDGER_COLUMNS = `id, seq::text as seq, store_id, item_id, ownership, owner_party_id, movement_type,
  quantity::text as quantity, unit_cost::text as unit_cost, value::text as value, cost_object_type,
  cost_object_id, source_doc_type, source_doc_id, source_line_id, ${DATE('business_date')},
  to_char(posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at, reverses_id`;

export interface LedgerRow {
  id: string;
  seq: string;
  store_id: string;
  item_id: string;
  ownership: string;
  owner_party_id: string | null;
  movement_type: string;
  quantity: string;
  unit_cost: string | null;
  value: string | null;
  cost_object_type: string | null;
  cost_object_id: string | null;
  source_doc_type: string;
  source_doc_id: string;
  source_line_id: string | null;
  business_date: string;
  posted_at: string;
  reverses_id: string | null;
}

export interface LedgerInsert {
  id: string;
  storeId: string;
  itemId: string;
  ownership: string;
  ownerPartyId: string | null;
  movementType: string;
  quantity: string;
  unitCost: string | null;
  value: string | null;
  costObjectType: string | null;
  costObjectId: string | null;
  sourceDocType: string;
  sourceDocId: string;
  sourceLineId: string | null;
  businessDate: string;
  postedAt: Date;
  idempotencyKey: string;
  reversesId: string | null;
  createdBy: string | null;
}

export async function insertLedger(db: Db, row: LedgerInsert): Promise<LedgerRow> {
  const rows = await db.query<LedgerRow>(
    `insert into inv_ledger (id, store_id, item_id, ownership, owner_party_id, movement_type, quantity,
       unit_cost, value, cost_object_type, cost_object_id, source_doc_type, source_doc_id,
       source_line_id, business_date, posted_at, idempotency_key, reverses_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     returning ${LEDGER_COLUMNS}`,
    [
      row.id,
      row.storeId,
      row.itemId,
      row.ownership,
      row.ownerPartyId,
      row.movementType,
      row.quantity,
      row.unitCost,
      row.value,
      row.costObjectType,
      row.costObjectId,
      row.sourceDocType,
      row.sourceDocId,
      row.sourceLineId,
      row.businessDate,
      row.postedAt.toISOString(),
      row.idempotencyKey,
      row.reversesId,
      row.createdBy,
    ],
  );
  return rows[0] as LedgerRow;
}

export async function findLedgerByKey(db: Db, key: string): Promise<LedgerRow | undefined> {
  const rows = await db.query<LedgerRow>(
    `select ${LEDGER_COLUMNS} from inv_ledger where idempotency_key = $1`,
    [key],
  );
  return rows[0];
}

export async function listLedgerBySource(
  db: Db,
  sourceDocType: string,
  sourceDocId: string,
): Promise<LedgerRow[]> {
  return db.query<LedgerRow>(
    `select ${LEDGER_COLUMNS} from inv_ledger
      where source_doc_type = $1 and source_doc_id = $2 order by seq`,
    [sourceDocType, sourceDocId],
  );
}

export interface LedgerSearch {
  projectIds?: readonly string[] | undefined;
  storeId?: string | undefined;
  itemId?: string | undefined;
  movementType?: string | undefined;
  ownership?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchLedger(
  db: Db,
  search: LedgerSearch,
): Promise<{ rows: LedgerRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['true'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (search.projectIds !== undefined) {
    add(
      'store_id in (select id from inv_stores where project_id = any(?::uuid[]))',
      search.projectIds,
    );
  }
  if (search.storeId !== undefined) add('store_id = ?', search.storeId);
  if (search.itemId !== undefined) add('item_id = ?', search.itemId);
  if (search.movementType !== undefined) add('movement_type = ?', search.movementType);
  if (search.ownership !== undefined) add('ownership = ?', search.ownership);
  const clause = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from inv_ledger where ${clause}`,
    params,
  );
  params.push(search.limit, search.offset);
  const rows = await db.query<LedgerRow>(
    `select ${LEDGER_COLUMNS} from inv_ledger where ${clause}
      order by seq desc limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { rows, total: countOf(total) };
}

/**
 * Spec section 2, `hasIssuesFromGrn`: whether stock left the store of a receipt line after that
 * receipt was posted (an issue, a transfer out or an adjustment out of the same item).
 */
export async function hasOutflowSince(db: Db, grnId: string): Promise<boolean> {
  const rows = await db.query<{ used: boolean }>(
    `select exists (
       select 1 from inv_ledger r
         join inv_ledger o on o.store_id = r.store_id and o.item_id = r.item_id
          and o.ownership = 'company' and o.seq > r.seq
          and o.movement_type in ('issue', 'transfer_out', 'adjustment_out')
        where r.source_doc_type = 'grn' and r.source_doc_id = $1) as used`,
    [grnId],
  );
  return rows[0]?.used === true;
}

/* ------------------------------------------------------------------ issues */

const ISSUE_COLUMNS = `id, store_id, item_id, ownership, owner_party_id, quantity::text as quantity,
  returned_quantity::text as returned_quantity, value::text as value,
  returned_value::text as returned_value, cost_object_type, cost_object_id, cost_code_id,
  valuation_movement_id, cost_entry_id, ${DATE('business_date')}, idempotency_key, version`;

export interface IssueRow {
  id: string;
  store_id: string;
  item_id: string;
  ownership: string;
  owner_party_id: string | null;
  quantity: string;
  returned_quantity: string;
  value: string | null;
  returned_value: string;
  cost_object_type: string;
  cost_object_id: string | null;
  cost_code_id: string | null;
  valuation_movement_id: string | null;
  cost_entry_id: string | null;
  business_date: string;
  idempotency_key: string;
  version: number;
}

export async function insertIssue(db: Db, values: Values, by: string, at: Date): Promise<IssueRow> {
  const all: Values = {
    ...values,
    created_at: at.toISOString(),
    created_by: by,
    updated_at: at.toISOString(),
    updated_by: by,
  };
  const names = Object.keys(all);
  const rows = await db.query<IssueRow>(
    `insert into inv_issues (${names.join(', ')})
     values (${names.map((_, i) => `$${i + 1}`).join(', ')}) returning ${ISSUE_COLUMNS}`,
    names.map((name) => all[name]),
  );
  return rows[0] as IssueRow;
}

export async function findIssue(db: Db, id: string, lock = false): Promise<IssueRow | undefined> {
  const rows = await db.query<IssueRow>(
    `select ${ISSUE_COLUMNS} from inv_issues where id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0];
}

export async function findIssueByKey(db: Db, key: string): Promise<IssueRow | undefined> {
  const rows = await db.query<IssueRow>(
    `select ${ISSUE_COLUMNS} from inv_issues where idempotency_key = $1`,
    [key],
  );
  return rows[0];
}

/** BR-6: records a (part) return against its issue and the live cost entry after restating. */
export async function recordIssueReturn(
  db: Db,
  id: string,
  change: {
    returnedQuantity: string;
    returnedValue: string;
    costEntryId: string | null;
    by: string;
    at: Date;
  },
): Promise<void> {
  await db.query(
    `update inv_issues
        set returned_quantity = $1, returned_value = $2, cost_entry_id = $3, updated_by = $4,
            updated_at = $5, version = version + 1
      where id = $6`,
    [
      change.returnedQuantity,
      change.returnedValue,
      change.costEntryId,
      change.by,
      change.at.toISOString(),
      id,
    ],
  );
}

/* --------------------------------------------------------------- transfers */

const TRANSFER_COLUMNS = `id, number, from_store_id, to_store_id, status, ${DATE('business_date')}, version`;

export interface TransferRow {
  id: string;
  number: string;
  from_store_id: string;
  to_store_id: string;
  status: string;
  business_date: string;
  version: number;
}

export interface TransferLineRow {
  id: string;
  transfer_id: string;
  item_id: string;
  ownership: string;
  owner_party_id: string | null;
  project_id: string | null;
  quantity: string;
}

export const insertTransfer = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<TransferRow>(db, 'inv_transfers', TRANSFER_COLUMNS, values, by, at);

export const findTransfer = (db: Db, id: string, lock = false) =>
  findRow<TransferRow>(db, 'inv_transfers', TRANSFER_COLUMNS, id, lock);

export const updateTransfer = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) => updateRow<TransferRow>(db, 'inv_transfers', TRANSFER_COLUMNS, id, version, values, by, at);

export async function insertTransferLine(db: Db, line: TransferLineRow): Promise<void> {
  await db.query(
    `insert into inv_transfer_lines (id, transfer_id, item_id, ownership, owner_party_id, project_id, quantity)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      line.id,
      line.transfer_id,
      line.item_id,
      line.ownership,
      line.owner_party_id,
      line.project_id,
      line.quantity,
    ],
  );
}

export const listTransferLines = (db: Db, transferId: string) =>
  db.query<TransferLineRow>(
    `select id, transfer_id, item_id, ownership, owner_party_id, project_id, quantity::text as quantity
       from inv_transfer_lines where transfer_id = $1 order by id`,
    [transferId],
  );

export async function searchTransfers(
  db: Db,
  search: { status?: string | undefined; limit: number; offset: number },
): Promise<{ rows: TransferRow[]; total: number }> {
  const params: unknown[] = [];
  let clause = 'deleted_at is null';
  if (search.status !== undefined) {
    params.push(search.status);
    clause += ` and status = $${params.length}`;
  }
  const total = await db.query<{ total: string }>(
    `select count(*) as total from inv_transfers where ${clause}`,
    params,
  );
  params.push(search.limit, search.offset);
  const rows = await db.query<TransferRow>(
    `select ${TRANSFER_COLUMNS} from inv_transfers where ${clause}
      order by created_at desc, id limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { rows, total: countOf(total) };
}

/* ------------------------------------------------------------------ counts */

const COUNT_COLUMNS = `id, number, store_id, status, ${DATE('counted_on')}, version`;

export interface CountRow {
  id: string;
  number: string;
  store_id: string;
  status: string;
  counted_on: string;
  version: number;
}

export interface CountLineRow {
  id: string;
  count_id: string;
  item_id: string;
  ownership: string;
  owner_party_id: string | null;
  system_qty: string;
  counted_qty: string;
}

export const insertCount = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<CountRow>(db, 'inv_counts', COUNT_COLUMNS, values, by, at);

export const findCount = (db: Db, id: string, lock = false) =>
  findRow<CountRow>(db, 'inv_counts', COUNT_COLUMNS, id, lock);

export const updateCount = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<CountRow>(db, 'inv_counts', COUNT_COLUMNS, id, version, values, by, at);

export async function insertCountLine(db: Db, line: CountLineRow): Promise<void> {
  await db.query(
    `insert into inv_count_lines (id, count_id, item_id, ownership, owner_party_id, system_qty, counted_qty)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      line.id,
      line.count_id,
      line.item_id,
      line.ownership,
      line.owner_party_id,
      line.system_qty,
      line.counted_qty,
    ],
  );
}

export const listCountLines = (db: Db, countId: string) =>
  db.query<CountLineRow>(
    `select id, count_id, item_id, ownership, owner_party_id, system_qty::text as system_qty,
            counted_qty::text as counted_qty
       from inv_count_lines where count_id = $1 order by id`,
    [countId],
  );

export async function searchCounts(
  db: Db,
  search: { status?: string | undefined; limit: number; offset: number },
): Promise<{ rows: CountRow[]; total: number }> {
  const params: unknown[] = [];
  let clause = 'deleted_at is null';
  if (search.status !== undefined) {
    params.push(search.status);
    clause += ` and status = $${params.length}`;
  }
  const total = await db.query<{ total: string }>(
    `select count(*) as total from inv_counts where ${clause}`,
    params,
  );
  params.push(search.limit, search.offset);
  const rows = await db.query<CountRow>(
    `select ${COUNT_COLUMNS} from inv_counts where ${clause}
      order by created_at desc, id limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { rows, total: countOf(total) };
}

/* ---------------------------------------------------------- reorder levels */

export interface ReorderRow {
  store_id: string;
  item_id: string;
  level: string;
  alerted: boolean;
}

export async function upsertReorderLevel(
  db: Db,
  input: { storeId: string; itemId: string; level: string; by: string; at: Date },
): Promise<ReorderRow> {
  const rows = await db.query<ReorderRow>(
    `insert into inv_reorder_levels (store_id, item_id, level, updated_at, updated_by)
     values ($1, $2, $3, $4, $5)
     on conflict (store_id, item_id)
       do update set level = excluded.level, updated_at = excluded.updated_at, updated_by = excluded.updated_by
     returning store_id, item_id, level::text as level, alerted`,
    [input.storeId, input.itemId, input.level, input.at.toISOString(), input.by],
  );
  return rows[0] as ReorderRow;
}

export async function lockReorderLevel(
  db: Db,
  storeId: string,
  itemId: string,
): Promise<ReorderRow | undefined> {
  const rows = await db.query<ReorderRow>(
    `select store_id, item_id, level::text as level, alerted from inv_reorder_levels
      where store_id = $1 and item_id = $2 for update`,
    [storeId, itemId],
  );
  return rows[0];
}

export async function setReorderAlerted(
  db: Db,
  storeId: string,
  itemId: string,
  alerted: boolean,
): Promise<void> {
  await db.query(
    'update inv_reorder_levels set alerted = $1 where store_id = $2 and item_id = $3',
    [alerted, storeId, itemId],
  );
}

/* ---------------------------------------------------------- client material */

export interface ClientMaterialRow {
  project_id: string;
  store_id: string;
  item_id: string;
  owner_party_id: string;
  received_qty: string;
  used_qty: string;
  returned_qty: string;
  balance_qty: string;
}

export const listClientMaterial = (db: Db, projectId: string) =>
  db.query<ClientMaterialRow>(
    `select project_id, store_id, item_id, owner_party_id, received_qty::text as received_qty,
            used_qty::text as used_qty, returned_qty::text as returned_qty,
            balance_qty::text as balance_qty
       from inv_v_client_material_balance where project_id = $1
      order by store_id, item_id, owner_party_id`,
    [projectId],
  );
