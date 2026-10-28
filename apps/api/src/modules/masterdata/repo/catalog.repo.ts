import type { Db } from '../types.js';
import {
  countOf,
  findRow,
  insertRow,
  likePattern,
  softDeleteRow,
  updateRow,
  type Values,
} from './crud.js';

// Units and conversions ------------------------------------------------------------------------

const UNIT_COLUMNS = 'code, name, kind, version';
export interface UnitRow {
  code: string;
  name: string;
  kind: string;
  version: number;
}

export const listUnits = (db: Db) =>
  db.query<UnitRow>(`select ${UNIT_COLUMNS} from mst_units where deleted_at is null order by code`);

export const findUnit = (db: Db, code: string, lock = false) =>
  findRow<UnitRow>(db, 'mst_units', UNIT_COLUMNS, { column: 'code', value: code }, lock);

export const insertUnit = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<UnitRow>(db, 'mst_units', UNIT_COLUMNS, values, by, at);

export const updateUnit = (
  db: Db,
  code: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) =>
  updateRow<UnitRow>(
    db,
    'mst_units',
    UNIT_COLUMNS,
    { column: 'code', value: code },
    version,
    values,
    by,
    at,
  );

export const deleteUnit = (db: Db, code: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'mst_units', { column: 'code', value: code }, version, by, at);

/** True when an item or a vendor price still uses the unit. */
export async function isUnitUsed(db: Db, code: string): Promise<boolean> {
  const rows = await db.query<{ used: boolean }>(
    `select (exists (select 1 from mst_items where unit_code = $1 and deleted_at is null)
          or exists (select 1 from mst_vendor_prices where unit_code = $1 and deleted_at is null)
          or exists (select 1 from mst_unit_conversions where from_unit = $1 or to_unit = $1)) as used`,
    [code],
  );
  return rows[0]?.used === true;
}

const CONVERSION_COLUMNS = 'id, from_unit, to_unit, factor::text as factor, version';
export interface ConversionRow {
  id: string;
  from_unit: string;
  to_unit: string;
  factor: string;
  version: number;
}

export const listConversions = (db: Db) =>
  db.query<ConversionRow>(
    `select ${CONVERSION_COLUMNS} from mst_unit_conversions order by from_unit, to_unit`,
  );

export async function findConversion(db: Db, id: string): Promise<ConversionRow | undefined> {
  const rows = await db.query<ConversionRow>(
    `select ${CONVERSION_COLUMNS} from mst_unit_conversions where id = $1`,
    [id],
  );
  return rows[0];
}

/** Either direction of the pair, to keep each pair unique (BR-5). */
export const findConversionBetween = (db: Db, a: string, b: string) =>
  db.query<ConversionRow>(
    `select ${CONVERSION_COLUMNS} from mst_unit_conversions
      where (from_unit = $1 and to_unit = $2) or (from_unit = $2 and to_unit = $1)`,
    [a, b],
  );

export const insertConversion = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<ConversionRow>(db, 'mst_unit_conversions', CONVERSION_COLUMNS, values, by, at);

export async function updateConversion(
  db: Db,
  id: string,
  version: number,
  factor: string,
  by: string,
  at: Date,
): Promise<ConversionRow | undefined> {
  const rows = await db.query<ConversionRow>(
    `update mst_unit_conversions
        set factor = $1, updated_at = $2, updated_by = $3, version = version + 1
      where id = $4 and version = $5
      returning ${CONVERSION_COLUMNS}`,
    [factor, at.toISOString(), by, id, version],
  );
  return rows[0];
}

export async function deleteConversion(db: Db, id: string, version: number): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    'delete from mst_unit_conversions where id = $1 and version = $2 returning id',
    [id, version],
  );
  return rows.length === 1;
}

// Item categories ------------------------------------------------------------------------------

const CATEGORY_COLUMNS = 'id, code, name, parent_id, version';
export interface CategoryRow {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  version: number;
}

export const listCategories = (db: Db) =>
  db.query<CategoryRow>(
    `select ${CATEGORY_COLUMNS} from mst_item_categories where deleted_at is null order by code`,
  );

export const findCategory = (db: Db, id: string, lock = false) =>
  findRow<CategoryRow>(
    db,
    'mst_item_categories',
    CATEGORY_COLUMNS,
    { column: 'id', value: id },
    lock,
  );

export async function findCategoryByCode(db: Db, code: string): Promise<CategoryRow | undefined> {
  const rows = await db.query<CategoryRow>(
    `select ${CATEGORY_COLUMNS} from mst_item_categories where code = $1 and deleted_at is null`,
    [code],
  );
  return rows[0];
}

export const insertCategory = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<CategoryRow>(db, 'mst_item_categories', CATEGORY_COLUMNS, values, by, at);

export const updateCategory = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) =>
  updateRow<CategoryRow>(
    db,
    'mst_item_categories',
    CATEGORY_COLUMNS,
    { column: 'id', value: id },
    version,
    values,
    by,
    at,
  );

export const deleteCategory = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'mst_item_categories', { column: 'id', value: id }, version, by, at);

/** True when a live child category or item hangs below the category. */
export async function isCategoryUsed(db: Db, id: string): Promise<boolean> {
  const rows = await db.query<{ used: boolean }>(
    `select (exists (select 1 from mst_item_categories where parent_id = $1 and deleted_at is null)
          or exists (select 1 from mst_items where category_id = $1 and deleted_at is null)) as used`,
    [id],
  );
  return rows[0]?.used === true;
}

// Items ----------------------------------------------------------------------------------------

const ITEM_COLUMNS = `id, code, name, category_id, unit_code, item_kind, stockable, default_tax_kind,
  reorder_level::text as reorder_level, default_cost_code_id, active, version`;
export interface ItemRow {
  id: string;
  code: string;
  name: string;
  category_id: string | null;
  unit_code: string;
  item_kind: string;
  stockable: boolean;
  default_tax_kind: string;
  reorder_level: string | null;
  default_cost_code_id: string | null;
  active: boolean;
  version: number;
}

export const insertItem = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<ItemRow>(db, 'mst_items', ITEM_COLUMNS, values, by, at);

export const updateItem = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) =>
  updateRow<ItemRow>(
    db,
    'mst_items',
    ITEM_COLUMNS,
    { column: 'id', value: id },
    version,
    values,
    by,
    at,
  );

export const findItem = (db: Db, id: string, lock = false) =>
  findRow<ItemRow>(db, 'mst_items', ITEM_COLUMNS, { column: 'id', value: id }, lock);

export async function findItemByCode(db: Db, code: string): Promise<ItemRow | undefined> {
  const rows = await db.query<ItemRow>(
    `select ${ITEM_COLUMNS} from mst_items where code = $1 and deleted_at is null`,
    [code],
  );
  return rows[0];
}

export const deleteItem = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'mst_items', { column: 'id', value: id }, version, by, at);

export interface ItemSearch {
  q?: string | undefined;
  categoryId?: string | undefined;
  kind?: string | undefined;
  active?: boolean | undefined;
  sort: 'code' | 'name' | 'kind';
  direction: 'asc' | 'desc';
  limit: number;
  offset: number;
}

const ITEM_SORT: Record<ItemSearch['sort'], string> = {
  code: 'code',
  name: 'lower(name)',
  kind: 'item_kind',
};

export async function searchItems(
  db: Db,
  search: ItemSearch,
): Promise<{ rows: ItemRow[]; total: number }> {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['deleted_at is null'];
  if (search.q !== undefined) {
    const text = add(likePattern(search.q));
    where.push(`(name ilike ${text} or code ilike ${text})`);
  }
  if (search.categoryId !== undefined) where.push(`category_id = ${add(search.categoryId)}`);
  if (search.kind !== undefined) where.push(`item_kind = ${add(search.kind)}`);
  if (search.active !== undefined) where.push(`active = ${add(search.active)}`);
  const clause = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from mst_items where ${clause}`,
    params,
  );
  const limit = add(search.limit);
  const offset = add(search.offset);
  const rows = await db.query<ItemRow>(
    `select ${ITEM_COLUMNS} from mst_items where ${clause}
      order by ${ITEM_SORT[search.sort]} ${search.direction === 'desc' ? 'desc' : 'asc'}, id
      limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: countOf(total) };
}
