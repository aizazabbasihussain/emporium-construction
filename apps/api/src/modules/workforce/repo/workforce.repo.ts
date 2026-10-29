import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

export interface TradeRow {
  code: string;
  name: string;
  version: number;
}

export interface WorkerRow {
  id: string;
  code: string;
  full_name: string;
  father_name: string | null;
  cnic: string | null;
  phone: string | null;
  trade_code: string;
  employment_type: string;
  contractor_party_id: string | null;
  joined_on: string;
  left_on: string | null;
  status: string;
  bank_or_wallet_info: string | null;
  version: number;
}

export interface RateRow {
  id: string;
  worker_id: string;
  pay_basis: string;
  amount: string;
  effective_from: string;
  effective_to: string | null;
  set_by: string | null;
  version: number;
}

export interface TeamRow {
  id: string;
  code: string;
  name: string;
  supervisor_user_id: string;
  active: boolean;
  version: number;
}

export interface MemberRow {
  team_id: string;
  worker_id: string;
  code: string;
  full_name: string;
  trade_code: string;
  from_date: string;
  to_date: string | null;
}

const DAY = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

// ---- trades ----

const TRADE_COLUMNS = 'code, name, version';

export async function listTrades(db: Db): Promise<TradeRow[]> {
  return db.query<TradeRow>(
    `select ${TRADE_COLUMNS} from lab_trades where deleted_at is null order by name`,
  );
}

export async function findTrade(db: Db, code: string): Promise<TradeRow | undefined> {
  const rows = await db.query<TradeRow>(
    `select ${TRADE_COLUMNS} from lab_trades where code = $1 and deleted_at is null`,
    [code],
  );
  return rows[0];
}

export async function insertTrade(
  db: Db,
  code: string,
  name: string,
  by: string,
  at: Date,
): Promise<TradeRow> {
  return insertRow<TradeRow>(db, 'lab_trades', TRADE_COLUMNS, { code, name }, by, at);
}

/** Undefined when the trade is gone or its version moved on. */
export async function updateTrade(
  db: Db,
  code: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
): Promise<TradeRow | undefined> {
  const names = Object.keys(values);
  const rows = await db.query<TradeRow>(
    `update lab_trades
        set ${names.map((name, i) => `${name} = $${i + 1}`).join(', ')},
            updated_at = $${names.length + 1}, updated_by = $${names.length + 2},
            version = version + 1
      where code = $${names.length + 3} and version = $${names.length + 4} and deleted_at is null
      returning ${TRADE_COLUMNS}`,
    [...names.map((name) => values[name]), at.toISOString(), by, code, version],
  );
  return rows[0];
}

export async function countWorkersOfTrade(db: Db, code: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    'select count(*) as n from lab_workers where trade_code = $1 and deleted_at is null',
    [code],
  );
  return Number(rows[0]?.n ?? 0);
}

// ---- workers ----

const WORKER_COLUMNS = `id, code, full_name, father_name, cnic, phone, trade_code, employment_type,
  contractor_party_id, ${DAY('joined_on')} as joined_on, ${DAY('left_on')} as left_on, status,
  bank_or_wallet_info, version`;

export const insertWorker = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<WorkerRow>(db, 'lab_workers', WORKER_COLUMNS, values, by, at);

/** Undefined when the worker is gone or its version moved on. */
export const updateWorker = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) => updateRow<WorkerRow>(db, 'lab_workers', WORKER_COLUMNS, id, version, values, by, at);

export const findWorker = (db: Db, id: string, lock = false) =>
  findRow<WorkerRow>(db, 'lab_workers', WORKER_COLUMNS, id, lock);

export async function softDeleteWorker(
  db: Db,
  id: string,
  version: number,
  by: string,
  at: Date,
): Promise<boolean> {
  const rows = await db.query(
    `update lab_workers set deleted_at = $1, updated_at = $1, updated_by = $2, version = version + 1
      where id = $3 and version = $4 and deleted_at is null returning id`,
    [at.toISOString(), by, id, version],
  );
  return rows.length === 1;
}

/** BR-1: the active worker, if any, that already holds the CNIC. */
export async function findActiveWorkerByCnic(db: Db, cnic: string): Promise<WorkerRow | undefined> {
  const rows = await db.query<WorkerRow>(
    `select ${WORKER_COLUMNS} from lab_workers
      where cnic = $1 and status = 'active' and deleted_at is null`,
    [cnic],
  );
  return rows[0];
}

export async function findWorkerByCode(db: Db, code: string): Promise<WorkerRow | undefined> {
  const rows = await db.query<WorkerRow>(
    `select ${WORKER_COLUMNS} from lab_workers where code = $1 and deleted_at is null`,
    [code],
  );
  return rows[0];
}

export interface WorkerSearch {
  /** Limits the search to the members of these teams on `asOf` (a supervisor's scope). */
  teamIds?: readonly string[] | undefined;
  asOf: string;
  teamId?: string | undefined;
  tradeCode?: string | undefined;
  status?: string | undefined;
  text?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchWorkers(
  db: Db,
  search: WorkerSearch,
): Promise<{ rows: WorkerRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['w.deleted_at is null'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll('$n', `$${params.length}`));
  };
  const inTeams = (sql: string, value: unknown) => {
    params.push(search.asOf);
    const asOf = `$${params.length}`;
    params.push(value);
    where.push(
      `exists (select 1 from lab_team_members m
                where m.worker_id = w.id and ${sql.replaceAll('$n', `$${params.length}`)}
                  and m.from_date <= ${asOf} and (m.to_date is null or m.to_date >= ${asOf}))`,
    );
  };
  if (search.teamIds !== undefined) inTeams('m.team_id = any($n::uuid[])', [...search.teamIds]);
  if (search.teamId !== undefined) inTeams('m.team_id = $n', search.teamId);
  if (search.tradeCode !== undefined) add('w.trade_code = $n', search.tradeCode);
  if (search.status !== undefined) add('w.status = $n', search.status);
  if (search.text !== undefined) {
    add(
      "(w.full_name ilike '%' || $n || '%' or w.code ilike '%' || $n || '%')",
      search.text.replace(/[\\%_]/g, (c) => `\\${c}`),
    );
  }
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from lab_workers w where ${filter}`,
    params,
  );
  const rows = await db.query<WorkerRow>(
    `select ${WORKER_COLUMNS} from lab_workers w
      where ${filter}
      order by w.full_name, w.id
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

/** The teams a worker belongs to on a date: at most one (BR-4). */
export async function teamIdsOfWorker(db: Db, workerId: string, date: string): Promise<string[]> {
  const rows = await db.query<{ team_id: string }>(
    `select team_id from lab_team_members
      where worker_id = $1 and from_date <= $2 and (to_date is null or to_date >= $2)`,
    [workerId, date],
  );
  return rows.map((row) => row.team_id);
}

// ---- pay rates ----

const RATE_COLUMNS = `id, worker_id, pay_basis, amount::text as amount,
  ${DAY('effective_from')} as effective_from, ${DAY('effective_to')} as effective_to, set_by,
  version`;

export const listRates = (db: Db, workerId: string) =>
  db.query<RateRow>(
    `select ${RATE_COLUMNS} from lab_pay_rates
      where worker_id = $1 and deleted_at is null order by effective_from`,
    [workerId],
  );

export const insertRate = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<RateRow>(db, 'lab_pay_rates', RATE_COLUMNS, values, by, at);

/** Undefined when the rate is gone or its version moved on. */
export const updateRate = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) => updateRow<RateRow>(db, 'lab_pay_rates', RATE_COLUMNS, id, version, values, by, at);

export async function countRates(db: Db, workerId: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    'select count(*) as n from lab_pay_rates where worker_id = $1',
    [workerId],
  );
  return Number(rows[0]?.n ?? 0);
}

// ---- teams ----

const TEAM_COLUMNS = 'id, code, name, supervisor_user_id, active, version';

export const insertTeam = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<TeamRow>(db, 'lab_teams', TEAM_COLUMNS, values, by, at);

/** Undefined when the team is gone or its version moved on. */
export const updateTeam = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) => updateRow<TeamRow>(db, 'lab_teams', TEAM_COLUMNS, id, version, values, by, at);

export const findTeam = (db: Db, id: string, lock = false) =>
  findRow<TeamRow>(db, 'lab_teams', TEAM_COLUMNS, id, lock);

export async function findTeamByCode(db: Db, code: string): Promise<TeamRow | undefined> {
  const rows = await db.query<TeamRow>(
    `select ${TEAM_COLUMNS} from lab_teams where code = $1 and deleted_at is null`,
    [code],
  );
  return rows[0];
}

export async function listTeams(db: Db, ids?: readonly string[]): Promise<TeamRow[]> {
  return db.query<TeamRow>(
    `select ${TEAM_COLUMNS} from lab_teams
      where deleted_at is null and ($1::uuid[] is null or id = any($1::uuid[])) order by code`,
    [ids === undefined ? null : [...ids]],
  );
}

export async function listTeamsOfSupervisor(db: Db, userId: string): Promise<TeamRow[]> {
  return db.query<TeamRow>(
    `select ${TEAM_COLUMNS} from lab_teams
      where supervisor_user_id = $1 and deleted_at is null order by code`,
    [userId],
  );
}

export async function countActiveTeamsOfSupervisor(db: Db, userId: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `select count(*) as n from lab_teams
      where supervisor_user_id = $1 and active and deleted_at is null`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function softDeleteTeam(
  db: Db,
  id: string,
  version: number,
  by: string,
  at: Date,
): Promise<boolean> {
  const rows = await db.query(
    `update lab_teams set deleted_at = $1, updated_at = $1, updated_by = $2, version = version + 1
      where id = $3 and version = $4 and deleted_at is null returning id`,
    [at.toISOString(), by, id, version],
  );
  return rows.length === 1;
}

// ---- team members ----

const MEMBER_COLUMNS = `m.team_id, m.worker_id, w.code, w.full_name, w.trade_code,
  ${DAY('m.from_date')} as from_date, ${DAY('m.to_date')} as to_date`;

/** The members of a team on a date. */
export const listMembersOn = (db: Db, teamId: string, date: string) =>
  db.query<MemberRow>(
    `select ${MEMBER_COLUMNS}
       from lab_team_members m join lab_workers w on w.id = m.worker_id
      where m.team_id = $1 and m.from_date <= $2 and (m.to_date is null or m.to_date >= $2)
        and w.deleted_at is null
      order by w.full_name, w.id`,
    [teamId, date],
  );

/** Every membership period of a worker, in any team. */
export const listMembershipsOfWorker = (db: Db, workerId: string) =>
  db.query<MemberRow>(
    `select ${MEMBER_COLUMNS}
       from lab_team_members m join lab_workers w on w.id = m.worker_id
      where m.worker_id = $1 order by m.from_date`,
    [workerId],
  );

export async function countMembers(db: Db, teamId: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    'select count(*) as n from lab_team_members where team_id = $1',
    [teamId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function insertMember(
  db: Db,
  member: { teamId: string; workerId: string; fromDate: string; toDate: string | null },
  by: string,
  at: Date,
): Promise<void> {
  await db.query(
    `insert into lab_team_members (team_id, worker_id, from_date, to_date, created_at, created_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [member.teamId, member.workerId, member.fromDate, member.toDate, at.toISOString(), by],
  );
}

export async function setMemberEnd(
  db: Db,
  member: { teamId: string; workerId: string; fromDate: string },
  toDate: string | null,
): Promise<void> {
  await db.query(
    'update lab_team_members set to_date = $1 where team_id = $2 and worker_id = $3 and from_date = $4',
    [toDate, member.teamId, member.workerId, member.fromDate],
  );
}

export async function deleteMember(
  db: Db,
  member: { teamId: string; workerId: string; fromDate: string },
): Promise<void> {
  await db.query(
    'delete from lab_team_members where team_id = $1 and worker_id = $2 and from_date = $3',
    [member.teamId, member.workerId, member.fromDate],
  );
}
