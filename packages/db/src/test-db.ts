import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from './migrations.js';
import { fromPglite } from './pglite.js';
import type { SqlDb } from './types.js';

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/** A fresh in-process Postgres (PGlite) with every migration applied. */
export async function createTestDb(migrationsDir: string = MIGRATIONS_DIR): Promise<SqlDb> {
  const db = fromPglite(new PGlite());
  await runMigrations(db, migrationsDir);
  return db;
}

class Rollback extends Error {}

/** Run `fn` inside a transaction that is always rolled back, so tests leave no data behind. */
export async function withRollback<T>(db: SqlDb, fn: (tx: SqlDb) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}
