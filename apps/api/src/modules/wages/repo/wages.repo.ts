import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

export interface PeriodRow {
  id: string;
  year: number;
  month: number;
  status: string;
  calculated_at: Date | null;
  total_net: string;
  submitted_by: string | null;
  submitted_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  reopen_reason: string | null;
  version: number;
}

export interface LineRow {
  id: string;
  period_id: string;
  worker_id: string;
  worker_code: string;
  worker_name: string;
  pay_basis: string;
  rate: string;
  present_days: string;
  half_days: string;
  paid_leave_days: string;
  off_days: string;
  absent_days: string;
  overtime_hours: string;
  basic_pay: string;
  overtime_pay: string;
  allowances: string;
  deductions: string;
  advance_recovery: string;
  gross_pay: string;
  net_pay: string;
  rounding_adjustment: string;
  shortfall: string;
  note: string | null;
}

export interface AdjustmentRow {
  id: string;
  line_id: string;
  kind: string;
  amount: string;
  reason: string;
  added_by: string | null;
  added_at: Date;
}

export interface AdvanceRow {
  id: string;
  worker_id: string;
  amount: string;
  issued_on: string;
  monthly_recovery: string;
  status: string;
  note: string | null;
  /** The amount less the recoveries of approved periods. */
  balance: string;
  version: number;
}

export interface RecoveryRow {
  advance_id: string;
  period_id: string;
  line_id: string;
  amount: string;
  applied: boolean;
}

const PERIOD_COLUMNS = `id, year, month, status, calculated_at, total_net::text as total_net,
  submitted_by, submitted_at, approved_by, approved_at, reopen_reason, version`;

const LINE_COLUMNS = `id, period_id, worker_id, worker_code, worker_name, pay_basis,
  rate::text as rate, present_days::text as present_days, half_days::text as half_days,
  paid_leave_days::text as paid_leave_days, off_days::text as off_days,
  absent_days::text as absent_days, overtime_hours::text as overtime_hours,
  basic_pay::text as basic_pay, overtime_pay::text as overtime_pay, allowances::text as allowances,
  deductions::text as deductions, advance_recovery::text as advance_recovery,
  gross_pay::text as gross_pay, net_pay::text as net_pay,
  rounding_adjustment::text as rounding_adjustment, shortfall::text as shortfall, note`;

const ADJUSTMENT_COLUMNS = `id, line_id, kind, amount::text as amount, reason, added_by, added_at`;

const ADVANCE_COLUMNS = `a.id, a.worker_id, a.amount::text as amount,
  to_char(a.issued_on, 'YYYY-MM-DD') as issued_on, a.monthly_recovery::text as monthly_recovery,
  a.status, a.note, a.version,
  (a.amount - coalesce((select sum(r.amount) from wag_advance_recoveries r
                         where r.advance_id = a.id and r.applied), 0))::text as balance`;

// ---- periods ----

export const insertPeriod = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<PeriodRow>(db, 'wag_periods', PERIOD_COLUMNS, values, by, at);

/** Undefined when the period is gone or its version moved on. */
export const updatePeriod = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<PeriodRow>(db, 'wag_periods', PERIOD_COLUMNS, id, version, values, by, at);

export const findPeriod = (db: Db, id: string, lock = false) =>
  findRow<PeriodRow>(db, 'wag_periods', PERIOD_COLUMNS, id, lock);

export async function findPeriodOfMonth(
  db: Db,
  year: number,
  month: number,
): Promise<PeriodRow | undefined> {
  const rows = await db.query<PeriodRow>(
    `select ${PERIOD_COLUMNS} from wag_periods
      where year = $1 and month = $2 and deleted_at is null`,
    [year, month],
  );
  return rows[0];
}

export async function searchPeriods(
  db: Db,
  search: { year?: number | undefined; status?: string | undefined; limit: number; offset: number },
): Promise<{ rows: PeriodRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (search.year !== undefined) {
    params.push(search.year);
    where.push(`year = $${params.length}`);
  }
  if (search.status !== undefined) {
    params.push(search.status);
    where.push(`status = $${params.length}`);
  }
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from wag_periods where ${filter}`,
    params,
  );
  const rows = await db.query<PeriodRow>(
    `select ${PERIOD_COLUMNS} from wag_periods where ${filter}
      order by year desc, month desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

/** BR-7 of attendance: the approved period that contains the date, if any. */
export async function findApprovedPeriodOfDate(
  db: Db,
  date: string,
): Promise<PeriodRow | undefined> {
  const rows = await db.query<PeriodRow>(
    `select ${PERIOD_COLUMNS} from wag_periods
      where status = 'approved' and deleted_at is null
        and year = extract(year from $1::date)::int and month = extract(month from $1::date)::int`,
    [date],
  );
  return rows[0];
}

// ---- lines ----

export interface NewLine {
  id: string;
  periodId: string;
  workerId: string;
  workerCode: string;
  workerName: string;
  payBasis: string;
  rate: string;
  presentDays: string;
  halfDays: string;
  paidLeaveDays: string;
  offDays: string;
  absentDays: string;
  overtimeHours: string;
  basicPay: string;
  overtimePay: string;
  allowances: string;
  deductions: string;
  advanceRecovery: string;
  grossPay: string;
  netPay: string;
  roundingAdjustment: string;
  shortfall: string;
}

/** BR-8: a calculation replaces the calculated values of the line of the worker. */
export async function upsertLine(db: Db, line: NewLine): Promise<LineRow> {
  const rows = await db.query<LineRow>(
    `insert into wag_lines (id, period_id, worker_id, worker_code, worker_name, pay_basis, rate,
        present_days, half_days, paid_leave_days, off_days, absent_days, overtime_hours, basic_pay,
        overtime_pay, allowances, deductions, advance_recovery, gross_pay, net_pay,
        rounding_adjustment, shortfall)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22)
     on conflict (period_id, worker_id) do update set
        worker_code = excluded.worker_code, worker_name = excluded.worker_name,
        pay_basis = excluded.pay_basis, rate = excluded.rate, present_days = excluded.present_days,
        half_days = excluded.half_days, paid_leave_days = excluded.paid_leave_days,
        off_days = excluded.off_days, absent_days = excluded.absent_days,
        overtime_hours = excluded.overtime_hours, basic_pay = excluded.basic_pay,
        overtime_pay = excluded.overtime_pay, allowances = excluded.allowances,
        deductions = excluded.deductions, advance_recovery = excluded.advance_recovery,
        gross_pay = excluded.gross_pay, net_pay = excluded.net_pay,
        rounding_adjustment = excluded.rounding_adjustment, shortfall = excluded.shortfall
     returning ${LINE_COLUMNS}`,
    [
      line.id,
      line.periodId,
      line.workerId,
      line.workerCode,
      line.workerName,
      line.payBasis,
      line.rate,
      line.presentDays,
      line.halfDays,
      line.paidLeaveDays,
      line.offDays,
      line.absentDays,
      line.overtimeHours,
      line.basicPay,
      line.overtimePay,
      line.allowances,
      line.deductions,
      line.advanceRecovery,
      line.grossPay,
      line.netPay,
      line.roundingAdjustment,
      line.shortfall,
    ],
  );
  return rows[0] as LineRow;
}

export async function listLines(db: Db, periodId: string): Promise<LineRow[]> {
  return db.query<LineRow>(
    `select ${LINE_COLUMNS} from wag_lines where period_id = $1 order by worker_code, id`,
    [periodId],
  );
}

export async function findLine(db: Db, id: string): Promise<LineRow | undefined> {
  const rows = await db.query<LineRow>(`select ${LINE_COLUMNS} from wag_lines where id = $1`, [id]);
  return rows[0];
}

export async function deleteLines(db: Db, ids: readonly string[]): Promise<void> {
  await db.query('delete from wag_lines where id = any($1::uuid[])', [[...ids]]);
}

/** BR-10: the line is re-totalled from its manual adjustments and the settlement is stored again. */
export async function setLineSettlement(
  db: Db,
  id: string,
  values: {
    allowances: string;
    deductions: string;
    advanceRecovery: string;
    grossPay: string;
    netPay: string;
    roundingAdjustment: string;
    shortfall: string;
  },
): Promise<LineRow> {
  const rows = await db.query<LineRow>(
    `update wag_lines
        set allowances = $2, deductions = $3, advance_recovery = $4, gross_pay = $5, net_pay = $6,
            rounding_adjustment = $7, shortfall = $8
      where id = $1
      returning ${LINE_COLUMNS}`,
    [
      id,
      values.allowances,
      values.deductions,
      values.advanceRecovery,
      values.grossPay,
      values.netPay,
      values.roundingAdjustment,
      values.shortfall,
    ],
  );
  return rows[0] as LineRow;
}

// ---- adjustments ----

export async function insertAdjustment(
  db: Db,
  adjustment: {
    id: string;
    lineId: string;
    kind: string;
    amount: string;
    reason: string;
    addedBy: string;
  },
): Promise<AdjustmentRow> {
  const rows = await db.query<AdjustmentRow>(
    `insert into wag_adjustments (id, line_id, kind, amount, reason, added_by)
     values ($1, $2, $3, $4, $5, $6)
     returning ${ADJUSTMENT_COLUMNS}`,
    [
      adjustment.id,
      adjustment.lineId,
      adjustment.kind,
      adjustment.amount,
      adjustment.reason,
      adjustment.addedBy,
    ],
  );
  return rows[0] as AdjustmentRow;
}

export async function listAdjustmentsOfPeriod(db: Db, periodId: string): Promise<AdjustmentRow[]> {
  return db.query<AdjustmentRow>(
    `select a.id, a.line_id, a.kind, a.amount::text as amount, a.reason, a.added_by, a.added_at
       from wag_adjustments a join wag_lines l on l.id = a.line_id
      where l.period_id = $1 order by a.added_at, a.id`,
    [periodId],
  );
}

// ---- advances ----

export async function insertAdvance(
  db: Db,
  values: Values,
  by: string,
  at: Date,
): Promise<AdvanceRow> {
  const created = await insertRow<{ id: string }>(db, 'wag_advances', 'id', values, by, at);
  return (await findAdvance(db, created.id)) as AdvanceRow;
}

export async function findAdvance(db: Db, id: string): Promise<AdvanceRow | undefined> {
  const rows = await db.query<AdvanceRow>(
    `select ${ADVANCE_COLUMNS} from wag_advances a where a.id = $1 and a.deleted_at is null`,
    [id],
  );
  return rows[0];
}

export async function searchAdvances(
  db: Db,
  search: {
    workerId?: string | undefined;
    status?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ rows: AdvanceRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['a.deleted_at is null'];
  if (search.workerId !== undefined) {
    params.push(search.workerId);
    where.push(`a.worker_id = $${params.length}`);
  }
  if (search.status !== undefined) {
    params.push(search.status);
    where.push(`a.status = $${params.length}`);
  }
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from wag_advances a where ${filter}`,
    params,
  );
  const rows = await db.query<AdvanceRow>(
    `select ${ADVANCE_COLUMNS} from wag_advances a where ${filter}
      order by a.issued_on desc, a.id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

/** BR-6: the open advances issued up to the date, oldest first, with their balances. */
export async function listOpenAdvances(
  db: Db,
  upTo: string,
  workerId?: string,
): Promise<AdvanceRow[]> {
  return db.query<AdvanceRow>(
    `select ${ADVANCE_COLUMNS} from wag_advances a
      where a.status = 'open' and a.deleted_at is null and a.issued_on <= $1
        and ($2::uuid is null or a.worker_id = $2::uuid)
      order by a.issued_on, a.id`,
    [upTo, workerId ?? null],
  );
}

/** Module interface `getWorkerAdvanceBalance`: what the worker still owes on open advances. */
export async function sumAdvanceBalance(db: Db, workerId: string): Promise<string> {
  const rows = await db.query<{ balance: string }>(
    `select coalesce(sum(a.amount - coalesce((select sum(r.amount) from wag_advance_recoveries r
                                               where r.advance_id = a.id and r.applied), 0)), 0)::numeric(18,2)::text
             as balance
       from wag_advances a
      where a.worker_id = $1 and a.status = 'open' and a.deleted_at is null`,
    [workerId],
  );
  return (rows[0] as { balance: string }).balance;
}

export async function setAdvanceStatus(db: Db, id: string, status: string): Promise<void> {
  await db.query(
    'update wag_advances set status = $2, version = version + 1, updated_at = now() where id = $1',
    [id, status],
  );
}

// ---- recoveries ----

export async function deleteRecoveriesOfPeriod(db: Db, periodId: string): Promise<void> {
  await db.query('delete from wag_advance_recoveries where period_id = $1', [periodId]);
}

export async function insertRecovery(
  db: Db,
  recovery: { advanceId: string; periodId: string; lineId: string; amount: string },
): Promise<void> {
  await db.query(
    `insert into wag_advance_recoveries (advance_id, period_id, line_id, amount)
     values ($1, $2, $3, $4)`,
    [recovery.advanceId, recovery.periodId, recovery.lineId, recovery.amount],
  );
}

export async function deleteRecoveriesOfLine(db: Db, lineId: string): Promise<void> {
  await db.query('delete from wag_advance_recoveries where line_id = $1', [lineId]);
}

/** BR-10: the manual allowances and deductions of a line, totalled. */
export async function sumAdjustments(
  db: Db,
  lineId: string,
): Promise<{ allowances: string; deductions: string }> {
  const rows = await db.query<{ allowances: string; deductions: string }>(
    `select coalesce(sum(amount) filter (where kind = 'allowance'), 0)::numeric(18,2)::text
              as allowances,
            coalesce(sum(amount) filter (where kind = 'deduction'), 0)::numeric(18,2)::text
              as deductions
       from wag_adjustments where line_id = $1`,
    [lineId],
  );
  return rows[0] as { allowances: string; deductions: string };
}

export async function countAdjustmentsOfLine(db: Db, lineId: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    'select count(*) as n from wag_adjustments where line_id = $1',
    [lineId],
  );
  return Number((rows[0] as { n: string }).n);
}

export async function listRecoveriesOfPeriod(db: Db, periodId: string): Promise<RecoveryRow[]> {
  return db.query<RecoveryRow>(
    `select advance_id, period_id, line_id, amount::text as amount, applied
       from wag_advance_recoveries where period_id = $1 order by advance_id`,
    [periodId],
  );
}

/** BR-6: balances move only when a period is approved and move back when it is reopened. */
export async function setRecoveriesApplied(
  db: Db,
  periodId: string,
  applied: boolean,
): Promise<void> {
  await db.query('update wag_advance_recoveries set applied = $2 where period_id = $1', [
    periodId,
    applied,
  ]);
}
