import type { SqlDb } from '@emporium/db';
import { createHash } from 'node:crypto';

/** A logical dump: one JSON document per table of the public schema (P1-21 BR-7). */
export interface Dump {
  tables: Record<string, string>;
}

const MIGRATIONS_TABLE = 'sys_migrations';

async function tablesOf(db: SqlDb): Promise<string[]> {
  const rows = await db.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  return rows.map((row) => row.tablename).filter((name) => name !== MIGRATIONS_TABLE);
}

/**
 * Reads every table as JSON text. Numbers stay in the text the database printed, so nothing passes
 * through a JavaScript float on the way out or back in.
 */
export async function dumpDatabase(db: SqlDb): Promise<Dump> {
  const tables: Record<string, string> = {};
  for (const table of await tablesOf(db)) {
    const [row] = await db.query<{ doc: string }>(
      `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text as doc from "${table}" t`,
    );
    tables[table] = (row as { doc: string }).doc;
  }
  return { tables };
}

/**
 * Loads a dump into a database that already has the migrations applied. Triggers and foreign keys
 * are switched off for the load (the data came from a database that enforced them) and identity
 * sequences are moved past the loaded rows.
 */
export async function restoreDatabase(target: SqlDb, dump: Dump): Promise<void> {
  await target.transaction(async (tx) => {
    await tx.exec('set local session_replication_role = replica');
    const tables = Object.keys(dump.tables);
    for (const table of tables) await tx.exec(`truncate table "${table}" restart identity cascade`);
    for (const table of tables) {
      await tx.query(
        `insert into "${table}" overriding system value
         select * from jsonb_populate_recordset(null::"${table}", $1::jsonb)`,
        [dump.tables[table]],
      );
    }
    const identities = await tx.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and is_identity = 'YES'`,
    );
    for (const { table_name, column_name } of identities) {
      await tx.query(
        `select setval(pg_get_serial_sequence($1, $2),
                       greatest((select coalesce(max("${column_name}"), 0) from "${table_name}"), 1))`,
        [`"${table_name}"`, column_name],
      );
    }
  });
}

/** One checksum per table, so two databases can be compared without printing their data. */
export async function fingerprint(db: SqlDb): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of await tablesOf(db)) {
    const rows = await db.query<{ row: string }>(
      `select to_jsonb(t)::text as row from "${table}" t order by 1`,
    );
    result[table] = createHash('sha256')
      .update(rows.map((row) => row.row).join('\n'))
      .digest('hex');
  }
  return result;
}
