import type { Db } from '../types.js';

export type Values = Record<string, unknown>;

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
     values (${names.map((_, i) => `$${i + 1}`).join(', ')})
     returning ${columns}`,
    names.map((name) => all[name]),
  );
  return rows[0] as T;
}

/** Optimistic update (constitution 5.2): undefined when the row is gone or the version moved on. */
export async function updateRow<T>(
  db: Db,
  table: string,
  columns: string,
  id: string,
  expectedVersion: number,
  values: Values,
  by: string | null,
  at: Date,
): Promise<T | undefined> {
  const names = Object.keys(values);
  const n = names.length;
  const sets = [
    ...names.map((name, i) => `${name} = $${i + 1}`),
    `updated_at = $${n + 1}`,
    `updated_by = $${n + 2}`,
    'version = version + 1',
  ];
  const rows = await db.query<T>(
    `update ${table}
        set ${sets.join(', ')}
      where id = $${n + 3} and version = $${n + 4} and deleted_at is null
      returning ${columns}`,
    [...names.map((name) => values[name]), at.toISOString(), by, id, expectedVersion],
  );
  return rows[0];
}

export async function softDeleteRow(
  db: Db,
  table: string,
  id: string,
  expectedVersion: number,
  by: string,
  at: Date,
): Promise<boolean> {
  const rows = await db.query<{ version: number }>(
    `update ${table}
        set deleted_at = $1, updated_at = $1, updated_by = $2, version = version + 1
      where id = $3 and version = $4 and deleted_at is null
      returning version`,
    [at.toISOString(), by, id, expectedVersion],
  );
  return rows.length === 1;
}

export async function findRow<T>(
  db: Db,
  table: string,
  columns: string,
  id: string,
  lock = false,
): Promise<T | undefined> {
  const rows = await db.query<T>(
    `select ${columns} from ${table} where id = $1 and deleted_at is null ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0];
}

/** Escapes `%`, `_` and `\` so a search text is matched literally. */
export const likePattern = (text: string): string =>
  `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
