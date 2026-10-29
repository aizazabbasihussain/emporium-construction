import type { Db } from '../types.js';
import { findRow, insertRow, likePattern, softDeleteRow, updateRow, type Values } from './crud.js';

export interface ProjectRow {
  id: string;
  code: string;
  name: string;
  party_id: string;
  sector: string;
  location_id: string | null;
  site_address: string | null;
  status: string;
  start_date: string | null;
  planned_end_date: string | null;
  actual_end_date: string | null;
  original_contract_value: string;
  quotation_id: string | null;
  estimate_id: string | null;
  project_manager_id: string | null;
  version: number;
}

const day = (column: string) => `to_char(${column}, 'YYYY-MM-DD') as ${column}`;

const PROJECT_COLUMNS = `id, code, name, party_id, sector, location_id, site_address, status,
  ${day('start_date')}, ${day('planned_end_date')}, ${day('actual_end_date')},
  original_contract_value::text as original_contract_value, quotation_id, estimate_id,
  project_manager_id, version`;

export const insertProject = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<ProjectRow>(db, 'prj_projects', PROJECT_COLUMNS, values, by, at);

/** Undefined when the project is gone or its version moved on. */
export const updateProject = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<ProjectRow>(db, 'prj_projects', PROJECT_COLUMNS, id, version, values, by, at);

export const findProject = (db: Db, id: string, lock = false) =>
  findRow<ProjectRow>(db, 'prj_projects', PROJECT_COLUMNS, id, lock);

/** BR-1: the project made from a quotation, if any. */
export async function findProjectByQuotation(
  db: Db,
  quotationId: string,
): Promise<ProjectRow | undefined> {
  const rows = await db.query<ProjectRow>(
    `select ${PROJECT_COLUMNS} from prj_projects where quotation_id = $1`,
    [quotationId],
  );
  return rows[0];
}

/** Master data asks whether a client is used by a project before it can be removed. */
export async function projectUsesParty(db: Db, partyId: string): Promise<boolean> {
  const rows = await db.query('select 1 from prj_projects where party_id = $1 limit 1', [partyId]);
  return rows.length > 0;
}

export interface ProjectSearch {
  q?: string | undefined;
  status?: string | undefined;
  partyId?: string | undefined;
  /** The ids a scoped user may see; undefined for everyone else. */
  onlyIds?: readonly string[] | undefined;
  limit: number;
  offset: number;
}

export async function searchProjects(
  db: Db,
  search: ProjectSearch,
): Promise<{ rows: ProjectRow[]; total: number }> {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['deleted_at is null'];
  if (search.q !== undefined && search.q.trim() !== '') {
    const pattern = add(likePattern(search.q.trim()));
    where.push(`(code ilike ${pattern} or name ilike ${pattern})`);
  }
  if (search.status !== undefined) where.push(`status = ${add(search.status)}`);
  if (search.partyId !== undefined) where.push(`party_id = ${add(search.partyId)}`);
  if (search.onlyIds !== undefined) where.push(`id = any(${add([...search.onlyIds])}::uuid[])`);
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from prj_projects where ${filter}`,
    params,
  );
  const limit = add(search.limit);
  const offset = add(search.offset);
  const rows = await db.query<ProjectRow>(
    `select ${PROJECT_COLUMNS} from prj_projects where ${filter}
      order by created_at desc, code desc, id limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

export interface BudgetLineRow {
  id: string;
  cost_code_id: string;
  description: string;
  budget_amount: string;
  source: string;
}

const BUDGET_COLUMNS =
  'id, cost_code_id, description, budget_amount::text as budget_amount, source';

export const listBudgetLines = (db: Db, projectId: string) =>
  db.query<BudgetLineRow>(
    `select ${BUDGET_COLUMNS} from prj_budget_lines
      where project_id = $1 and deleted_at is null order by created_at, id`,
    [projectId],
  );

export const insertBudgetLine = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<BudgetLineRow>(db, 'prj_budget_lines', BUDGET_COLUMNS, values, by, at);

/** Budget lines move with their project, so the project's version is the guard; no line version. */
export async function setBudgetAmount(
  db: Db,
  id: string,
  amount: string,
  by: string | null,
  at: Date,
): Promise<void> {
  await db.query(
    `update prj_budget_lines
        set budget_amount = $1, updated_at = $2, updated_by = $3, version = version + 1
      where id = $4 and deleted_at is null`,
    [amount, at.toISOString(), by, id],
  );
}

export async function removeBudgetLine(
  db: Db,
  id: string,
  by: string | null,
  at: Date,
): Promise<void> {
  await db.query(
    `update prj_budget_lines
        set deleted_at = $1, updated_at = $1, updated_by = $2, version = version + 1
      where id = $3 and deleted_at is null`,
    [at.toISOString(), by, id],
  );
}

/** BR-6 of master data: whether a cost code has posted costs or open budget lines. */
export async function costCodeUsage(
  db: Db,
  costCodeId: string,
): Promise<{ postedCosts: boolean; openBudgetLines: boolean }> {
  const posted = await db.query(
    `select 1 from prj_cost_entries where cost_code_id = $1 and status <> 'reversed' limit 1`,
    [costCodeId],
  );
  const budget = await db.query(
    `select 1 from prj_budget_lines l join prj_projects p on p.id = l.project_id
      where l.cost_code_id = $1 and l.deleted_at is null
        and p.status not in ('closed', 'cancelled') limit 1`,
    [costCodeId],
  );
  return { postedCosts: posted.length > 0, openBudgetLines: budget.length > 0 };
}

export interface TaskRow {
  id: string;
  project_id: string;
  name: string;
  assigned_to_user: string | null;
  start_date: string | null;
  due_date: string | null;
  status: string;
  percent_complete: number;
  version: number;
}

const TASK_COLUMNS = `id, project_id, name, assigned_to_user, ${day('start_date')},
  ${day('due_date')}, status, percent_complete, version`;

export const listTasks = (db: Db, projectId: string) =>
  db.query<TaskRow>(
    `select ${TASK_COLUMNS} from prj_tasks
      where project_id = $1 and deleted_at is null order by created_at, id`,
    [projectId],
  );

export const insertTask = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<TaskRow>(db, 'prj_tasks', TASK_COLUMNS, values, by, at);

export const updateTask = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<TaskRow>(db, 'prj_tasks', TASK_COLUMNS, id, version, values, by, at);

export const findTask = (db: Db, id: string, lock = false) =>
  findRow<TaskRow>(db, 'prj_tasks', TASK_COLUMNS, id, lock);

export const softDeleteTask = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'prj_tasks', id, version, by, at);

/** The task percents of several projects, grouped by project (BR-10). */
export async function taskPercentsFor(
  db: Db,
  projectIds: readonly string[],
): Promise<Map<string, number[]>> {
  const rows = await db.query<{ project_id: string; percent_complete: number }>(
    `select project_id, percent_complete from prj_tasks
      where project_id = any($1::uuid[]) and deleted_at is null`,
    [[...projectIds]],
  );
  const byProject = new Map<string, number[]>();
  for (const row of rows) {
    byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row.percent_complete]);
  }
  return byProject;
}

export interface SupervisedProjectRow {
  id: string;
  code: string;
  name: string;
  project_manager_id: string | null;
  supervisor_ids: string[];
}

/**
 * Active projects with a supervisor assigned on the date (an assignment ends the day its end date
 * names, as `isAssignmentOpen` has it). Daily progress reports (P1-15 BR-6) use it.
 */
export const listSupervisedProjects = (db: Db, date: string) =>
  db.query<SupervisedProjectRow>(
    `select p.id, p.code, p.name, p.project_manager_id,
            array_agg(distinct a.user_id::text order by a.user_id::text) as supervisor_ids
       from prj_projects p
       join prj_supervisor_assignments a on a.project_id = p.id
      where p.deleted_at is null and p.status = 'active'
        and a.from_date <= $1 and (a.to_date is null or a.to_date > $1)
      group by p.id, p.code, p.name, p.project_manager_id
      order by p.code`,
    [date],
  );

/** The budget of a project added up per cost code (BR-8). */
export const budgetByCode = (db: Db, projectId: string) =>
  db.query<{ cost_code_id: string; budget: string }>(
    `select cost_code_id, sum(budget_amount)::text as budget from prj_budget_lines
      where project_id = $1 and deleted_at is null group by cost_code_id`,
    [projectId],
  );

export interface AssignmentRow {
  user_id: string;
  from_date: string;
  to_date: string | null;
}

export const listAssignments = (db: Db, projectId: string) =>
  db.query<AssignmentRow>(
    `select user_id, ${day('from_date')}, ${day('to_date')} from prj_supervisor_assignments
      where project_id = $1 order by from_date, user_id`,
    [projectId],
  );

export async function insertAssignment(
  db: Db,
  projectId: string,
  userId: string,
  from: string,
  to: string | null,
): Promise<void> {
  await db.query(
    `insert into prj_supervisor_assignments (project_id, user_id, from_date, to_date)
     values ($1, $2, $3, $4)`,
    [projectId, userId, from, to],
  );
}

/** BR-9: ending an assignment stamps its end date (null reopens it); the row stays as history. */
export async function setAssignmentEnd(
  db: Db,
  projectId: string,
  userId: string,
  from: string,
  to: string | null,
): Promise<void> {
  await db.query(
    `update prj_supervisor_assignments set to_date = $1
      where project_id = $2 and user_id = $3 and from_date = $4`,
    [to, projectId, userId, from],
  );
}
