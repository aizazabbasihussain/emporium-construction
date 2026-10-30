import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

export interface SheetRow {
  id: string;
  team_id: string;
  sheet_date: string;
  status: string;
  total: string;
  submitted_by: string | null;
  submitted_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  unlock_reason: string | null;
  version: number;
}

export interface EntryRow {
  id: string;
  sheet_id: string;
  line_no: number;
  worker_id: string;
  worker_code: string;
  worker_name: string;
  status: string;
  overtime_hours: string;
  overtime_project_id: string | null;
  remarks: string | null;
  daily_rate: string | null;
  day_value: string | null;
  overtime_value: string | null;
  overtime_cost_entry_id: string | null;
}

export interface AllocationRow {
  id: string;
  entry_id: string;
  cost_object_id: string;
  fraction: string;
  cost_code_id: string;
  amount: string | null;
  cost_entry_id: string | null;
}

const SHEET_COLUMNS = `id, team_id, to_char(sheet_date, 'YYYY-MM-DD') as sheet_date, status,
  total::text as total, submitted_by, submitted_at, approved_by, approved_at, unlock_reason,
  version`;

const ENTRY_COLUMNS = `id, sheet_id, line_no, worker_id, worker_code, worker_name, status,
  overtime_hours::text as overtime_hours, overtime_project_id, remarks,
  daily_rate::text as daily_rate, day_value::text as day_value,
  overtime_value::text as overtime_value, overtime_cost_entry_id`;

const ALLOCATION_COLUMNS = `id, entry_id, cost_object_id, fraction::text as fraction, cost_code_id,
  amount::text as amount, cost_entry_id`;

// ---- sheets ----

export const insertSheet = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<SheetRow>(db, 'att_sheets', SHEET_COLUMNS, values, by, at);

/** Undefined when the sheet is gone or its version moved on. */
export const updateSheet = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<SheetRow>(db, 'att_sheets', SHEET_COLUMNS, id, version, values, by, at);

export const findSheet = (db: Db, id: string, lock = false) =>
  findRow<SheetRow>(db, 'att_sheets', SHEET_COLUMNS, id, lock);

export async function findSheetOfTeamDay(
  db: Db,
  teamId: string,
  date: string,
  lock = false,
): Promise<SheetRow | undefined> {
  const rows = await db.query<SheetRow>(
    `select ${SHEET_COLUMNS} from att_sheets
      where team_id = $1 and sheet_date = $2 and deleted_at is null ${lock ? 'for update' : ''}`,
    [teamId, date],
  );
  return rows[0];
}

export interface SheetSearch {
  /** Limits the search to these teams; undefined means every team. */
  teamIds?: readonly string[] | undefined;
  teamId?: string | undefined;
  date?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchSheets(
  db: Db,
  search: SheetSearch,
): Promise<{ rows: SheetRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (search.teamIds !== undefined) add('team_id = any(?::uuid[])', [...search.teamIds]);
  if (search.teamId !== undefined) add('team_id = ?', search.teamId);
  if (search.date !== undefined) add('sheet_date = ?', search.date);
  if (search.from !== undefined) add('sheet_date >= ?', search.from);
  if (search.to !== undefined) add('sheet_date <= ?', search.to);
  if (search.status !== undefined) add('status = ?', search.status);
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from att_sheets where ${filter}`,
    params,
  );
  const rows = await db.query<SheetRow>(
    `select ${SHEET_COLUMNS} from att_sheets where ${filter}
      order by sheet_date desc, id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

// ---- entries and allocations ----

export const listEntries = (db: Db, sheetId: string) =>
  db.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from att_entries where sheet_id = $1 order by line_no`,
    [sheetId],
  );

export const listAllocations = (db: Db, sheetId: string) =>
  db.query<AllocationRow>(
    `select a.id, a.entry_id, a.cost_object_id, a.fraction::text as fraction, a.cost_code_id,
            a.amount::text as amount, a.cost_entry_id
       from att_allocations a join att_entries e on e.id = a.entry_id
      where e.sheet_id = $1 order by e.line_no, a.position`,
    [sheetId],
  );

export interface NewEntry {
  id: string;
  lineNo: number;
  workerId: string;
  workerCode: string;
  workerName: string;
  status: string;
  overtimeHours: string;
  overtimeProjectId: string | null;
  remarks: string | null;
  dailyRate: string | null;
  dayValue: string | null;
  overtimeValue: string | null;
  allocations: {
    id: string;
    projectId: string;
    fraction: string;
    costCodeId: string;
    amount: string | null;
  }[];
}

/** Replaces everything on a sheet, and the worker-day claims that go with it. */
export async function replaceEntries(
  db: Db,
  sheetId: string,
  date: string,
  entries: readonly NewEntry[],
): Promise<void> {
  await db.query(
    `delete from att_allocations where entry_id in (select id from att_entries where sheet_id = $1)`,
    [sheetId],
  );
  await db.query('delete from att_entries where sheet_id = $1', [sheetId]);
  await db.query('delete from att_worker_days where sheet_id = $1', [sheetId]);
  for (const entry of entries) {
    await db.query(
      `insert into att_entries (id, sheet_id, line_no, worker_id, worker_code, worker_name, status,
         overtime_hours, overtime_project_id, remarks, daily_rate, day_value, overtime_value)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        entry.id,
        sheetId,
        entry.lineNo,
        entry.workerId,
        entry.workerCode,
        entry.workerName,
        entry.status,
        entry.overtimeHours,
        entry.overtimeProjectId,
        entry.remarks,
        entry.dailyRate,
        entry.dayValue,
        entry.overtimeValue,
      ],
    );
    await db.query(
      'insert into att_worker_days (worker_id, work_date, sheet_id) values ($1, $2, $3)',
      [entry.workerId, date, sheetId],
    );
    for (const [index, allocation] of entry.allocations.entries()) {
      await db.query(
        `insert into att_allocations
           (id, entry_id, position, cost_object_id, fraction, cost_code_id, amount)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          allocation.id,
          entry.id,
          index + 1,
          allocation.projectId,
          allocation.fraction,
          allocation.costCodeId,
          allocation.amount,
        ],
      );
    }
  }
}

/** BR-4, BR-6: the pay frozen on an entry when its sheet is submitted. */
export async function freezeEntry(
  db: Db,
  id: string,
  values: { dailyRate: string; dayValue: string; overtimeValue: string },
): Promise<void> {
  await db.query(
    'update att_entries set daily_rate = $2, day_value = $3, overtime_value = $4 where id = $1',
    [id, values.dailyRate, values.dayValue, values.overtimeValue],
  );
}

export async function freezeAllocation(db: Db, id: string, amount: string): Promise<void> {
  await db.query('update att_allocations set amount = $2 where id = $1', [id, amount]);
}

/** BR-6: the latest ledger entry of an allocation's chain. */
export async function setAllocationEntry(db: Db, id: string, costEntryId: string): Promise<void> {
  await db.query('update att_allocations set cost_entry_id = $2 where id = $1', [id, costEntryId]);
}

export async function setOvertimeEntry(db: Db, id: string, costEntryId: string): Promise<void> {
  await db.query('update att_entries set overtime_cost_entry_id = $2 where id = $1', [
    id,
    costEntryId,
  ]);
}

// ---- worker days ----

/** BR-2: workers of the list that are already on another sheet on the date. */
export const listWorkerDayConflicts = (
  db: Db,
  workerIds: readonly string[],
  date: string,
  exceptSheetId: string | null,
) =>
  db.query<{ worker_id: string }>(
    `select worker_id from att_worker_days
      where work_date = $1 and worker_id = any($2::uuid[]) and sheet_id is distinct from $3`,
    [date, [...workerIds], exceptSheetId],
  );

// ---- queries for other modules ----

export interface ApprovedDayRow {
  sheet_id: string;
  team_id: string;
  sheet_date: string;
  worker_id: string;
  status: string;
  overtime_hours: string;
  day_value: string;
  overtime_value: string;
  entry_id: string;
}

export const listApprovedDays = (db: Db, workerId: string, from: string, to: string) =>
  db.query<ApprovedDayRow>(
    `select s.id as sheet_id, s.team_id, to_char(s.sheet_date, 'YYYY-MM-DD') as sheet_date,
            e.worker_id, e.status, e.overtime_hours::text as overtime_hours,
            e.day_value::text as day_value, e.overtime_value::text as overtime_value,
            e.id as entry_id
       from att_entries e join att_sheets s on s.id = e.sheet_id
      where e.worker_id = $1 and s.sheet_date between $2 and $3
        and s.status = 'approved' and s.deleted_at is null
      order by s.sheet_date`,
    [workerId, from, to],
  );

export const listAllocationsOfEntries = (db: Db, entryIds: readonly string[]) =>
  db.query<AllocationRow>(
    `select ${ALLOCATION_COLUMNS} from att_allocations
      where entry_id = any($1::uuid[]) order by entry_id, position`,
    [[...entryIds]],
  );

/** Workers who worked on a project on a date, on a sheet that is submitted or approved. */
export async function countWorkersOnProject(
  db: Db,
  projectId: string,
  date: string,
): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `select count(distinct e.worker_id) as n
       from att_allocations a
       join att_entries e on e.id = a.entry_id
       join att_sheets s on s.id = e.sheet_id
      where a.cost_object_id = $1 and s.sheet_date = $2
        and s.status in ('submitted', 'approved') and s.deleted_at is null
        and e.status in ('present', 'half_day')`,
    [projectId, date],
  );
  return Number(rows[0]?.n ?? 0);
}

/** BR-6 of workforce: the sheets a worker is on, up to a date, that are not approved. */
export const listUnapprovedSheetsOfWorker = (db: Db, workerId: string, upTo: string) =>
  db.query<{ id: string; date: string }>(
    `select s.id, to_char(s.sheet_date, 'YYYY-MM-DD') as date
       from att_worker_days w join att_sheets s on s.id = w.sheet_id
      where w.worker_id = $1 and s.sheet_date <= $2 and s.status <> 'approved'
        and s.deleted_at is null
      order by s.sheet_date`,
    [workerId, upTo],
  );

export const listSheetsInPeriod = (db: Db, from: string, to: string) =>
  db.query<{ id: string; team_id: string; date: string; status: string }>(
    `select id, team_id, to_char(sheet_date, 'YYYY-MM-DD') as date, status
       from att_sheets where sheet_date between $1 and $2 and deleted_at is null
      order by sheet_date, team_id`,
    [from, to],
  );
