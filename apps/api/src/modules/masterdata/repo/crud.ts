import type { Db } from '../types.js';

/** A value stored as jsonb. */
export interface Json {
  json: unknown;
}

export type Values = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && 'json' in value;

const bind = (value: unknown): unknown => (isJson(value) ? JSON.stringify(value.json) : value);

const placeholder = (value: unknown, n: number): string =>
  isJson(value) ? `$${n}::jsonb` : `$${n}`;

/**
 * Column names always come from code, never from a request. `columns` is the select list that is
 * returned (dates are formatted as text so no time zone shifts them).
 */
export async function insertRow<T>(
  db: Db,
  table: string,
  columns: string,
  values: Values,
  by: string,
  at: Date,
): Promise<T> {
  const all: Values = {
    ...values,
    created_at: at.toISOString(),
    created_by: by,
    updated_at: at.toISOString(),
    updated_by: by,
  };
  const names = Object.keys(all);
  const rows = await db.query<T>(
    `insert into ${table} (${names.join(', ')})
     values (${names.map((name, i) => placeholder(all[name], i + 1)).join(', ')})
     returning ${columns}`,
    names.map((name) => bind(all[name])),
  );
  return rows[0] as T;
}

/** Optimistic update (constitution 5.2): undefined when the row is gone or the version moved on. */
export async function updateRow<T>(
  db: Db,
  table: string,
  columns: string,
  key: { column: string; value: string },
  expectedVersion: number,
  values: Values,
  by: string,
  at: Date,
): Promise<T | undefined> {
  const names = Object.keys(values);
  const n = names.length;
  const sets = [
    ...names.map((name, i) => `${name} = ${placeholder(values[name], i + 1)}`),
    `updated_at = $${n + 1}`,
    `updated_by = $${n + 2}`,
    'version = version + 1',
  ];
  const rows = await db.query<T>(
    `update ${table}
        set ${sets.join(', ')}
      where ${key.column} = $${n + 3} and version = $${n + 4} and deleted_at is null
      returning ${columns}`,
    [...names.map((name) => bind(values[name])), at.toISOString(), by, key.value, expectedVersion],
  );
  return rows[0];
}

export async function softDeleteRow(
  db: Db,
  table: string,
  key: { column: string; value: string },
  expectedVersion: number,
  by: string,
  at: Date,
): Promise<boolean> {
  const rows = await db.query<{ version: number }>(
    `update ${table}
        set deleted_at = $1, updated_at = $1, updated_by = $2, version = version + 1
      where ${key.column} = $3 and version = $4 and deleted_at is null
      returning version`,
    [at.toISOString(), by, key.value, expectedVersion],
  );
  return rows.length === 1;
}

export async function findRow<T>(
  db: Db,
  table: string,
  columns: string,
  key: { column: string; value: string },
  lock = false,
): Promise<T | undefined> {
  const rows = await db.query<T>(
    `select ${columns} from ${table}
      where ${key.column} = $1 and deleted_at is null ${lock ? 'for update' : ''}`,
    [key.value],
  );
  return rows[0];
}

/** Escapes `%`, `_` and `\` so a search text is matched literally. */
export const likePattern = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

export const countOf = (rows: { total: string }[]): number => Number(rows[0]?.total ?? 0);
