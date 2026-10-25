import type { Db } from '../types.js';
import { countOf, findRow, insertRow, softDeleteRow, updateRow, type Values } from './crud.js';

// Cost codes -----------------------------------------------------------------------------------

const COST_CODE_COLUMNS = 'id, code, name, parent_id, kind, active, version';
export interface CostCodeRow {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  kind: string;
  active: boolean;
  version: number;
}

export const listCostCodes = (db: Db) =>
  db.query<CostCodeRow>(
    `select ${COST_CODE_COLUMNS} from mst_cost_codes where deleted_at is null order by code`,
  );

export const findCostCode = (db: Db, id: string, lock = false) =>
  findRow<CostCodeRow>(db, 'mst_cost_codes', COST_CODE_COLUMNS, { column: 'id', value: id }, lock);

export async function findCostCodeByCode(db: Db, code: string): Promise<CostCodeRow | undefined> {
  const rows = await db.query<CostCodeRow>(
    `select ${COST_CODE_COLUMNS} from mst_cost_codes where code = $1 and deleted_at is null`,
    [code],
  );
  return rows[0];
}

export const insertCostCode = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<CostCodeRow>(db, 'mst_cost_codes', COST_CODE_COLUMNS, values, by, at);

export const updateCostCode = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) =>
  updateRow<CostCodeRow>(
    db,
    'mst_cost_codes',
    COST_CODE_COLUMNS,
    { column: 'id', value: id },
    version,
    values,
    by,
    at,
  );

export const deleteCostCode = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'mst_cost_codes', { column: 'id', value: id }, version, by, at);

export async function hasCostCodeChildren(db: Db, id: string): Promise<boolean> {
  const rows = await db.query<{ used: boolean }>(
    `select exists (select 1 from mst_cost_codes where parent_id = $1 and deleted_at is null) as used`,
    [id],
  );
  return rows[0]?.used === true;
}

// Vendor prices --------------------------------------------------------------------------------

const PRICE_COLUMNS = `id, vendor_id, item_id, unit_code, rate::text as rate,
  to_char(valid_from, 'YYYY-MM-DD') as valid_from, to_char(valid_to, 'YYYY-MM-DD') as valid_to, version`;
export interface PriceRow {
  id: string;
  vendor_id: string;
  item_id: string;
  unit_code: string;
  rate: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
}

export const insertPrice = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<PriceRow>(db, 'mst_vendor_prices', PRICE_COLUMNS, values, by, at);

export const updatePrice = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) =>
  updateRow<PriceRow>(
    db,
    'mst_vendor_prices',
    PRICE_COLUMNS,
    { column: 'id', value: id },
    version,
    values,
    by,
    at,
  );

export const findPrice = (db: Db, id: string, lock = false) =>
  findRow<PriceRow>(db, 'mst_vendor_prices', PRICE_COLUMNS, { column: 'id', value: id }, lock);

export const deletePrice = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'mst_vendor_prices', { column: 'id', value: id }, version, by, at);

export interface PriceSearch {
  vendorId?: string | undefined;
  itemId?: string | undefined;
  /** Only prices in force on this date (`yyyy-mm-dd`). */
  onDate?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchPrices(
  db: Db,
  search: PriceSearch,
): Promise<{ rows: PriceRow[]; total: number }> {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['deleted_at is null'];
  if (search.vendorId !== undefined) where.push(`vendor_id = ${add(search.vendorId)}`);
  if (search.itemId !== undefined) where.push(`item_id = ${add(search.itemId)}`);
  if (search.onDate !== undefined) {
    const date = add(search.onDate);
    where.push(`valid_from <= ${date}::date and (valid_to is null or valid_to >= ${date}::date)`);
  }
  const clause = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from mst_vendor_prices where ${clause}`,
    params,
  );
  const limit = add(search.limit);
  const offset = add(search.offset);
  const rows = await db.query<PriceRow>(
    `select ${PRICE_COLUMNS} from mst_vendor_prices where ${clause}
      order by item_id, vendor_id, valid_from desc, id limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: countOf(total) };
}
