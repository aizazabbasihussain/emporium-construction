import { updateWithVersion } from '@emporium/db';
import type { Db } from '../types.js';

export interface SeriesRow {
  code: string;
  prefix: string;
  padding: number;
  reset_yearly: boolean;
  gapless: boolean;
  /** bigint columns arrive as strings or numbers depending on the driver. */
  start_value: string | number;
  next_value: string | number;
  current_year: number | null;
  last_allocated_at: Date | null;
  version: number;
}

export interface SeriesDefinition {
  code: string;
  prefix: string;
  padding: number;
  resetYearly: boolean;
  gapless: boolean;
  startValue: number;
  nextValue: number;
}

/** Row lock: concurrent allocations queue on this row until the caller's transaction ends (BR-1). */
export async function lockSeries(db: Db, code: string): Promise<SeriesRow | undefined> {
  const rows = await db.query<SeriesRow>(
    'select * from sys_number_series where code = $1 and deleted_at is null for update',
    [code],
  );
  return rows[0];
}

export async function storeCounter(
  db: Db,
  code: string,
  next: { nextValue: number; currentYear: number | null },
): Promise<void> {
  await db.query(
    `update sys_number_series
        set next_value = $2, current_year = $3, last_allocated_at = now(), updated_at = now()
      where code = $1`,
    [code, next.nextValue, next.currentYear],
  );
}

export async function listSeries(db: Db): Promise<SeriesRow[]> {
  return db.query<SeriesRow>(
    'select * from sys_number_series where deleted_at is null order by code',
  );
}

export async function insertSeries(
  db: Db,
  def: SeriesDefinition,
  actor: string | null,
): Promise<SeriesRow> {
  const rows = await db.query<SeriesRow>(
    `insert into sys_number_series
       (code, prefix, padding, reset_yearly, gapless, start_value, next_value, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     returning *`,
    [
      def.code,
      def.prefix,
      def.padding,
      def.resetYearly,
      def.gapless,
      def.startValue,
      def.nextValue,
      actor,
    ],
  );
  return rows[0] as SeriesRow;
}

/** Updates an existing series definition under the optimistic version check. */
export function updateSeriesDefinition(
  db: Db,
  update: {
    code: string;
    expectedVersion: number;
    patch: Record<string, unknown>;
    actor: string | null;
  },
) {
  return updateWithVersion<Record<string, unknown>>(db, {
    table: 'sys_number_series',
    idColumn: 'code',
    id: update.code,
    expectedVersion: update.expectedVersion,
    patch: update.patch,
    actorUserId: update.actor,
  });
}
