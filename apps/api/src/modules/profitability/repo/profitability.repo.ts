import type { Db } from '../types.js';

/* ------------------------------------------------------------------ thresholds */

export interface ThresholdRow {
  id: string;
  scope: string;
  project_id: string | null;
  margin_floor_percent: string;
  overspend_percent: string;
  receivable_age_days: number;
  active: boolean;
  version: number;
}

const THRESHOLD_COLUMNS = `id, scope, project_id, margin_floor_percent::text as margin_floor_percent,
  overspend_percent::text as overspend_percent, receivable_age_days, active, version`;

export async function insertThreshold(
  db: Db,
  row: {
    id: string;
    scope: string;
    projectId: string | null;
    marginFloorPercent: string;
    overspendPercent: string;
    receivableAgeDays: number;
    active: boolean;
  },
  by: string | null,
  at: Date,
): Promise<ThresholdRow> {
  const rows = await db.query<ThresholdRow>(
    `insert into pft_thresholds
       (id, scope, project_id, margin_floor_percent, overspend_percent, receivable_age_days, active,
        created_at, created_by, updated_at, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9)
     returning ${THRESHOLD_COLUMNS}`,
    [
      row.id,
      row.scope,
      row.projectId,
      row.marginFloorPercent,
      row.overspendPercent,
      row.receivableAgeDays,
      row.active,
      at.toISOString(),
      by,
    ],
  );
  return rows[0] as ThresholdRow;
}

export async function findThreshold(db: Db, id: string): Promise<ThresholdRow | undefined> {
  const rows = await db.query<ThresholdRow>(
    `select ${THRESHOLD_COLUMNS} from pft_thresholds where id = $1 and deleted_at is null`,
    [id],
  );
  return rows[0];
}

/** The live row of a scope: the company's, or one project's. */
export async function findThresholdOfScope(
  db: Db,
  scope: string,
  projectId: string | null,
): Promise<ThresholdRow | undefined> {
  const rows = await db.query<ThresholdRow>(
    `select ${THRESHOLD_COLUMNS} from pft_thresholds
      where scope = $1 and project_id is not distinct from $2::uuid and deleted_at is null`,
    [scope, projectId],
  );
  return rows[0];
}

export const listThresholds = (db: Db, onlyActive: boolean) =>
  db.query<ThresholdRow>(
    `select ${THRESHOLD_COLUMNS} from pft_thresholds
      where deleted_at is null and (not $1::boolean or active)
      order by scope, project_id nulls first, id`,
    [onlyActive],
  );

/** Undefined when the row is gone or its version moved on. */
export async function updateThreshold(
  db: Db,
  id: string,
  version: number,
  values: {
    marginFloorPercent: string;
    overspendPercent: string;
    receivableAgeDays: number;
    active: boolean;
  },
  by: string | null,
  at: Date,
): Promise<ThresholdRow | undefined> {
  const rows = await db.query<ThresholdRow>(
    `update pft_thresholds
        set margin_floor_percent = $3, overspend_percent = $4, receivable_age_days = $5, active = $6,
            updated_at = $7, updated_by = $8, version = version + 1
      where id = $1 and version = $2 and deleted_at is null
      returning ${THRESHOLD_COLUMNS}`,
    [
      id,
      version,
      values.marginFloorPercent,
      values.overspendPercent,
      values.receivableAgeDays,
      values.active,
      at.toISOString(),
      by,
    ],
  );
  return rows[0];
}

export async function softDeleteThreshold(
  db: Db,
  id: string,
  version: number,
  by: string | null,
  at: Date,
): Promise<boolean> {
  const rows = await db.query(
    `update pft_thresholds
        set deleted_at = $1, updated_at = $1, updated_by = $2, version = version + 1
      where id = $3 and version = $4 and deleted_at is null
      returning id`,
    [at.toISOString(), by, id, version],
  );
  return rows.length === 1;
}

/* ------------------------------------------------------------------ forecasts */

export interface ForecastRow {
  id: string;
  project_id: string;
  cost_to_complete: string;
  note: string;
  forecast_date: string;
  set_by: string;
}

const FORECAST_COLUMNS = `id, project_id, cost_to_complete::text as cost_to_complete, note,
  to_char(forecast_date, 'YYYY-MM-DD') as forecast_date, set_by`;

export async function insertForecast(
  db: Db,
  row: {
    id: string;
    projectId: string;
    costToComplete: string;
    note: string;
    forecastDate: string;
    setBy: string;
  },
  at: Date,
): Promise<ForecastRow> {
  const rows = await db.query<ForecastRow>(
    `insert into pft_forecasts (id, project_id, cost_to_complete, note, forecast_date, set_by, created_at)
     values ($1, $2, $3, $4, $5::date, $6, $7)
     returning ${FORECAST_COLUMNS}`,
    [
      row.id,
      row.projectId,
      row.costToComplete,
      row.note,
      row.forecastDate,
      row.setBy,
      at.toISOString(),
    ],
  );
  return rows[0] as ForecastRow;
}

/** The latest forecast of a project made on or before a date. */
export async function findLatestForecast(
  db: Db,
  projectId: string,
  asOf: string,
): Promise<ForecastRow | undefined> {
  const rows = await db.query<ForecastRow>(
    `select ${FORECAST_COLUMNS} from pft_forecasts
      where project_id = $1 and forecast_date <= $2::date
      order by forecast_date desc, seq desc limit 1`,
    [projectId, asOf],
  );
  return rows[0];
}

/* ------------------------------------------------------------------ alert state */

export interface AlertRow {
  id: string;
  project_id: string;
  alert_code: string;
  raised_at: string;
  cleared_at: string | null;
}

const ALERT_COLUMNS = `id, project_id, alert_code, to_char(raised_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as raised_at,
  to_char(cleared_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as cleared_at`;

export const listOpenAlertCodes = (db: Db, projectId: string) =>
  db
    .query<{ alert_code: string }>(
      'select alert_code from pft_alert_state where project_id = $1 and cleared_at is null order by alert_code',
      [projectId],
    )
    .then((rows) => rows.map((row) => row.alert_code));

export async function insertAlert(
  db: Db,
  row: { id: string; projectId: string; alertCode: string },
  at: Date,
): Promise<void> {
  await db.query(
    'insert into pft_alert_state (id, project_id, alert_code, raised_at) values ($1, $2, $3, $4)',
    [row.id, row.projectId, row.alertCode, at.toISOString()],
  );
}

export async function clearAlert(
  db: Db,
  projectId: string,
  alertCode: string,
  at: Date,
): Promise<void> {
  await db.query(
    `update pft_alert_state set cleared_at = $3
      where project_id = $1 and alert_code = $2 and cleared_at is null`,
    [projectId, alertCode, at.toISOString()],
  );
}

/** Open alerts first, then the most recently cleared ones; `onlyOpen` leaves the cleared out. */
export const listAlerts = (db: Db, filter: { onlyOpen: boolean; limit: number }) =>
  db.query<AlertRow>(
    `select ${ALERT_COLUMNS} from pft_alert_state
      where not $1::boolean or cleared_at is null
      order by (cleared_at is null) desc, raised_at desc, id
      limit $2`,
    [filter.onlyOpen, filter.limit],
  );
