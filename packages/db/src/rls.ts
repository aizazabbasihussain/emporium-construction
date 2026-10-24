import type { SqlDb } from './types.js';

/** Tables in the public schema that do not have Row Level Security enabled (constitution 7.7). */
export async function findTablesWithoutRls(db: SqlDb): Promise<string[]> {
  const rows = await db.query<{ relname: string }>(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
      order by c.relname`,
  );
  return rows.map((r) => r.relname);
}
