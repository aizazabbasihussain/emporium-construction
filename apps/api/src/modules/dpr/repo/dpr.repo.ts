import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

export interface ReportRow {
  id: string;
  project_id: string;
  report_date: string;
  author_id: string;
  weather: string;
  work_done: string;
  issues: string;
  safety_notes: string;
  manpower_manual: { trade: string; count: number }[];
  status: string;
  submitted_at: Date | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  version: number;
}

export interface TaskUpdateRow {
  task_id: string;
  percent_complete: number;
  note: string | null;
}

export interface MaterialNoteRow {
  description: string;
  quantity: string | null;
  unit_code: string | null;
}

const REPORT_COLUMNS = `id, project_id, to_char(report_date, 'YYYY-MM-DD') as report_date, author_id,
  weather, work_done, issues, safety_notes, manpower_manual, status, submitted_at, reviewed_by,
  reviewed_at, review_note, version`;

export const insertReport = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<ReportRow>(db, 'dpr_reports', REPORT_COLUMNS, values, by, at);

/** Undefined when the report is gone or its version moved on. */
export const updateReport = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<ReportRow>(db, 'dpr_reports', REPORT_COLUMNS, id, version, values, by, at);

export const findReport = (db: Db, id: string, lock = false) =>
  findRow<ReportRow>(db, 'dpr_reports', REPORT_COLUMNS, id, lock);

/** BR-2: the report an author already has for a project and date, if any. */
export async function findReportOfAuthorDay(
  db: Db,
  projectId: string,
  date: string,
  authorId: string,
): Promise<ReportRow | undefined> {
  const rows = await db.query<ReportRow>(
    `select ${REPORT_COLUMNS} from dpr_reports
      where project_id = $1 and report_date = $2 and author_id = $3 and deleted_at is null`,
    [projectId, date, authorId],
  );
  return rows[0];
}

export interface ReportSearch {
  /** Limits the search to these projects (a supervisor's scope); undefined means every project. */
  projectIds?: readonly string[] | undefined;
  projectId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: string | undefined;
  authorId?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchReports(
  db: Db,
  search: ReportSearch,
): Promise<{ rows: ReportRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('$n', `$${params.length}`));
  };
  if (search.projectIds !== undefined) add('project_id = any($n::uuid[])', [...search.projectIds]);
  if (search.projectId !== undefined) add('project_id = $n', search.projectId);
  if (search.from !== undefined) add('report_date >= $n', search.from);
  if (search.to !== undefined) add('report_date <= $n', search.to);
  if (search.status !== undefined) add('status = $n', search.status);
  if (search.authorId !== undefined) add('author_id = $n', search.authorId);
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from dpr_reports where ${filter}`,
    params,
  );
  const rows = await db.query<ReportRow>(
    `select ${REPORT_COLUMNS} from dpr_reports where ${filter}
      order by report_date desc, created_at desc, id
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

// ---- children ----

export const listTaskUpdates = (db: Db, reportId: string) =>
  db.query<TaskUpdateRow>(
    `select task_id, percent_complete, note from dpr_task_updates
      where report_id = $1 order by task_id`,
    [reportId],
  );

/** The task updates of a report are saved as a whole list. */
export async function replaceTaskUpdates(
  db: Db,
  reportId: string,
  updates: readonly { taskId: string; percentComplete: number; note: string | null }[],
): Promise<void> {
  await db.query('delete from dpr_task_updates where report_id = $1', [reportId]);
  for (const update of updates) {
    await db.query(
      `insert into dpr_task_updates (report_id, task_id, percent_complete, note)
       values ($1, $2, $3, $4)`,
      [reportId, update.taskId, update.percentComplete, update.note],
    );
  }
}

export const listMaterialNotes = (db: Db, reportId: string) =>
  db.query<MaterialNoteRow>(
    `select description, quantity::text as quantity, unit_code from dpr_material_notes
      where report_id = $1 order by line_no`,
    [reportId],
  );

/** The material notes of a report are saved as a whole list. */
export async function replaceMaterialNotes(
  db: Db,
  reportId: string,
  notes: readonly {
    id: string;
    description: string;
    quantity: string | null;
    unitCode: string | null;
  }[],
): Promise<void> {
  await db.query('delete from dpr_material_notes where report_id = $1', [reportId]);
  for (const [index, note] of notes.entries()) {
    await db.query(
      `insert into dpr_material_notes (id, report_id, line_no, description, quantity, unit_code)
       values ($1, $2, $3, $4, $5, $6)`,
      [note.id, reportId, index + 1, note.description, note.quantity, note.unitCode],
    );
  }
}

// ---- submission status ----

/** The projects that have a filed report for the date (read view `dpr_v_submission_status`). */
export async function listFiledProjectIds(db: Db, date: string): Promise<string[]> {
  const rows = await db.query<{ project_id: string }>(
    'select project_id from dpr_v_submission_status where report_date = $1',
    [date],
  );
  return rows.map((row) => row.project_id);
}

/** BR-6: true when this call is the first to claim the day for the 18:00 job. */
export async function claimMissingRun(db: Db, date: string, missing: number): Promise<boolean> {
  const rows = await db.query(
    `insert into dpr_missing_runs (report_date, missing_count) values ($1, $2)
     on conflict (report_date) do nothing returning report_date`,
    [date, missing],
  );
  return rows.length === 1;
}
