import { ConflictError, NotFoundError, ValidationError } from '@emporium/domain';
import type { SqlDb } from './types.js';

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export interface VersionedUpdate {
  table: string;
  id: string;
  expectedVersion: number;
  /** Column names and new values; base columns (`id`, `version`, ...) cannot be patched. */
  patch: Record<string, unknown>;
  actorUserId?: string | null;
  /** Name of the primary key column (default `id`). */
  idColumn?: string;
}

const PROTECTED = new Set([
  'id',
  'version',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
]);

/**
 * Optimistic concurrency (BR-10): updates the row only if `version` equals the expected one,
 * increments `version`, and returns the new row. A version mismatch is a ConflictError (HTTP 409).
 */
export async function updateWithVersion<T = Record<string, unknown>>(
  db: SqlDb,
  { table, id, expectedVersion, patch, actorUserId = null, idColumn = 'id' }: VersionedUpdate,
): Promise<T> {
  const columns = Object.keys(patch);
  for (const name of [table, idColumn, ...columns]) {
    if (!IDENTIFIER.test(name)) {
      throw new ValidationError('invalid_identifier', `Invalid SQL identifier: ${name}`);
    }
  }
  const forbidden = columns.find((c) => PROTECTED.has(c));
  if (forbidden !== undefined) {
    throw new ValidationError('protected_column', `Column ${forbidden} cannot be patched`);
  }

  const params: unknown[] = [id, expectedVersion, actorUserId];
  const assignments = columns.map((column) => {
    params.push(patch[column]);
    return `${column} = $${params.length}`;
  });
  const rows = await db.query<T>(
    `update ${table}
        set ${[...assignments, 'version = version + 1', 'updated_at = now()', 'updated_by = $3'].join(', ')}
      where ${idColumn} = $1 and version = $2 and deleted_at is null
      returning *`,
    params,
  );
  if (rows[0] !== undefined) return rows[0];

  const existing = await db.query(
    `select version from ${table} where ${idColumn} = $1 and deleted_at is null`,
    [id],
  );
  if (existing.length === 0) throw new NotFoundError();
  throw new ConflictError('version_conflict', 'The record was changed by someone else', {
    expectedVersion,
  });
}
