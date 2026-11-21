import { findRow, insertRow, updateRow, type Values } from './crud.js';
import type { Db } from '../types.js';

const TS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const RUN_COLUMNS = `id, period_id, year, month, status, revision,
  to_char(finalized_at at time zone 'UTC', ${TS}) as finalized_at, finalized_by,
  total_net::text as total_net, total_paid::text as total_paid, gross_pay::text as gross_pay,
  allocated_cost::text as allocated_cost, cost_difference::text as cost_difference,
  cost_difference_treatment, version`;

export interface RunRow {
  id: string;
  period_id: string;
  year: number;
  month: number;
  status: string;
  revision: number;
  finalized_at: string | null;
  finalized_by: string | null;
  total_net: string;
  total_paid: string;
  gross_pay: string | null;
  allocated_cost: string | null;
  cost_difference: string | null;
  cost_difference_treatment: string;
  version: number;
}

export const insertRun = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<RunRow>(db, 'pyr_runs', RUN_COLUMNS, values, by, at);

export const findRun = (db: Db, id: string, lock = false) =>
  findRow<RunRow>(db, 'pyr_runs', RUN_COLUMNS, id, lock);

export const updateRun = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<RunRow>(db, 'pyr_runs', RUN_COLUMNS, id, version, values, by, at);

export async function findRunOfPeriod(db: Db, periodId: string): Promise<RunRow | undefined> {
  const rows = await db.query<RunRow>(
    `select ${RUN_COLUMNS} from pyr_runs where period_id = $1 and deleted_at is null`,
    [periodId],
  );
  return rows[0];
}

export async function listRuns(
  db: Db,
  page: { limit: number; offset: number },
): Promise<{ rows: RunRow[]; total: number }> {
  const total = await db.query<{ total: string }>(
    'select count(*) as total from pyr_runs where deleted_at is null',
  );
  const rows = await db.query<RunRow>(
    `select ${RUN_COLUMNS} from pyr_runs where deleted_at is null
      order by year desc, month desc limit $1 offset $2`,
    [page.limit, page.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

/** Wages asks whether the run of its period still allows the period to be reopened. */
export async function runLocksPeriod(db: Db, periodId: string): Promise<boolean> {
  const rows = await db.query<{ n: string }>(
    `select count(*) as n from pyr_runs
      where period_id = $1 and status <> 'draft' and deleted_at is null`,
    [periodId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

// ---- lines ----

const LINE_COLUMNS = `id, run_id, worker_id, net_pay::text as net_pay, payment_method, payment_status,
  to_char(paid_on, 'YYYY-MM-DD') as paid_on, payment_id, cashbook_txn_id, payslip_number`;

export interface LineRow {
  id: string;
  run_id: string;
  worker_id: string;
  net_pay: string;
  payment_method: string | null;
  payment_status: string;
  paid_on: string | null;
  payment_id: string | null;
  cashbook_txn_id: string | null;
  payslip_number: string | null;
}

export const insertLine = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<LineRow>(db, 'pyr_lines', LINE_COLUMNS, values, by, at);

export const findLine = (db: Db, id: string) => findRow<LineRow>(db, 'pyr_lines', LINE_COLUMNS, id);

export const listLines = (db: Db, runId: string) =>
  db.query<LineRow>(
    `select ${LINE_COLUMNS} from pyr_lines
      where run_id = $1 and deleted_at is null order by created_at, id`,
    [runId],
  );

export const listLinesOfPayment = (db: Db, paymentId: string) =>
  db.query<LineRow>(
    `select ${LINE_COLUMNS} from pyr_lines where payment_id = $1 order by created_at, id`,
    [paymentId],
  );

export async function setPayslipNumber(
  db: Db,
  lineId: string,
  number: string | null,
  at: Date,
  by: string | null,
): Promise<void> {
  await db.query(
    `update pyr_lines set payslip_number = $2, updated_at = $3, updated_by = $4,
            version = version + 1 where id = $1`,
    [lineId, number, at.toISOString(), by],
  );
}

export async function markLinePaid(
  db: Db,
  lineId: string,
  paid: { paymentId: string; method: string; paidOn: string; cashbookTxnId: string },
  at: Date,
  by: string,
): Promise<void> {
  await db.query(
    `update pyr_lines set payment_status = 'paid', payment_id = $2, payment_method = $3,
            paid_on = $4, cashbook_txn_id = $5, updated_at = $6, updated_by = $7,
            version = version + 1 where id = $1`,
    [lineId, paid.paymentId, paid.method, paid.paidOn, paid.cashbookTxnId, at.toISOString(), by],
  );
}

export async function markPaymentLinesUnpaid(
  db: Db,
  paymentId: string,
  at: Date,
  by: string,
): Promise<void> {
  await db.query(
    `update pyr_lines set payment_status = 'unpaid', payment_id = null, payment_method = null,
            paid_on = null, cashbook_txn_id = null, updated_at = $2, updated_by = $3,
            version = version + 1 where payment_id = $1`,
    [paymentId, at.toISOString(), by],
  );
}

export async function paidTotal(db: Db, runId: string): Promise<string> {
  const rows = await db.query<{ total: string }>(
    `select coalesce(sum(net_pay), 0)::text as total from pyr_lines
      where run_id = $1 and payment_status = 'paid' and deleted_at is null`,
    [runId],
  );
  return rows[0]?.total ?? '0';
}

// ---- payments ----

const PAYMENT_COLUMNS = `id, run_id, to_char(payment_date, 'YYYY-MM-DD') as payment_date, method,
  account_id, amount::text as amount, status, approval_doc_id,
  to_char(reversed_on, 'YYYY-MM-DD') as reversed_on, reversal_reason, version`;

export interface PaymentRow {
  id: string;
  run_id: string;
  payment_date: string;
  method: string;
  account_id: string;
  amount: string;
  status: string;
  approval_doc_id: string | null;
  reversed_on: string | null;
  reversal_reason: string | null;
  version: number;
}

export const insertPayment = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<PaymentRow>(db, 'pyr_payments', PAYMENT_COLUMNS, values, by, at);

export const findPayment = (db: Db, id: string, lock = false) =>
  findRow<PaymentRow>(db, 'pyr_payments', PAYMENT_COLUMNS, id, lock);

export const updatePayment = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) => updateRow<PaymentRow>(db, 'pyr_payments', PAYMENT_COLUMNS, id, version, values, by, at);

export const listPayments = (db: Db, runId: string) =>
  db.query<PaymentRow>(
    `select ${PAYMENT_COLUMNS} from pyr_payments
      where run_id = $1 and deleted_at is null order by created_at, id`,
    [runId],
  );

// ---- cost finalization ----

export interface CostEntryRow {
  id: string;
  project_id: string;
  source_doc_type: string;
  source_doc_id: string;
  source_line_id: string | null;
  cost_code_id: string;
  amount: string;
  entry_date: string;
  approved_entry_id: string;
  posted_entry_id: string;
}

export async function insertCostEntry(
  db: Db,
  values: {
    id: string;
    runId: string;
    revision: number;
    projectId: string;
    sourceDocType: string;
    sourceDocId: string;
    sourceLineId: string | null;
    costCodeId: string;
    amount: string;
    entryDate: string;
    approvedEntryId: string;
    postedEntryId: string;
  },
): Promise<void> {
  await db.query(
    `insert into pyr_cost_entries (id, run_id, revision, project_id, source_doc_type, source_doc_id,
            source_line_id, cost_code_id, amount, entry_date, approved_entry_id, posted_entry_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      values.id,
      values.runId,
      values.revision,
      values.projectId,
      values.sourceDocType,
      values.sourceDocId,
      values.sourceLineId,
      values.costCodeId,
      values.amount,
      values.entryDate,
      values.approvedEntryId,
      values.postedEntryId,
    ],
  );
}

export const listCostEntries = (db: Db, runId: string, revision: number) =>
  db.query<CostEntryRow>(
    `select id, project_id, source_doc_type, source_doc_id, source_line_id, cost_code_id, amount::text as amount,
            to_char(entry_date, 'YYYY-MM-DD') as entry_date, approved_entry_id, posted_entry_id
       from pyr_cost_entries where run_id = $1 and revision = $2 order by id`,
    [runId, revision],
  );

export async function deleteCostEntries(db: Db, runId: string, revision: number): Promise<void> {
  await db.query('delete from pyr_cost_entries where run_id = $1 and revision = $2', [
    runId,
    revision,
  ]);
}

export interface AdjustmentRow {
  id: string;
  project_id: string | null;
  amount: string;
  ledger_entry_id: string;
}

export async function insertAdjustment(
  db: Db,
  values: {
    id: string;
    runId: string;
    revision: number;
    projectId: string | null;
    amount: string;
    ledgerEntryId: string;
  },
): Promise<void> {
  await db.query(
    `insert into pyr_cost_adjustments (id, run_id, revision, project_id, amount, ledger_entry_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      values.id,
      values.runId,
      values.revision,
      values.projectId,
      values.amount,
      values.ledgerEntryId,
    ],
  );
}

export const listAdjustments = (db: Db, runId: string, revision: number) =>
  db.query<AdjustmentRow>(
    `select id, project_id, amount::text as amount, ledger_entry_id from pyr_cost_adjustments
      where run_id = $1 and revision = $2 order by id`,
    [runId, revision],
  );

export async function deleteAdjustments(db: Db, runId: string, revision: number): Promise<void> {
  await db.query('delete from pyr_cost_adjustments where run_id = $1 and revision = $2', [
    runId,
    revision,
  ]);
}

// ---- unpaid wages ----

export interface UnpaidRow {
  run_id: string;
  year: number;
  month: number;
  line_id: string;
  worker_id: string;
  net_pay: string;
  age_days: number;
}

/**
 * Wages paid as of a date that belong to a project. A payment counts from its date until it was
 * reversed; its share for the project is the project's part of the run's allocated cost in the
 * current revision (attendance entries and the adjustment that spreads the difference).
 */
export const paidWagesForProject = (db: Db, projectId: string, asOf: string) =>
  db
    .query<{ total: string }>(
      `with parts as (
         select r.id as run_id,
                coalesce((select sum(e.amount) from pyr_cost_entries e
                           where e.run_id = r.id and e.revision = r.revision and e.project_id = $1), 0)
              + coalesce((select sum(a.amount) from pyr_cost_adjustments a
                           where a.run_id = r.id and a.revision = r.revision and a.project_id = $1), 0)
                as mine,
                coalesce((select sum(e.amount) from pyr_cost_entries e
                           where e.run_id = r.id and e.revision = r.revision), 0)
              + coalesce((select sum(a.amount) from pyr_cost_adjustments a
                           where a.run_id = r.id and a.revision = r.revision), 0)
                as everyone
           from pyr_runs r
       )
       select coalesce(sum(round(p.amount * parts.mine / parts.everyone, 2)), 0)::numeric(18,2)::text as total
         from pyr_payments p
         join parts on parts.run_id = p.run_id
        where parts.everyone <> 0 and p.deleted_at is null
          and p.payment_date <= $2::date
          and (p.status = 'paid' or p.reversed_on > $2::date)`,
      [projectId, asOf],
    )
    .then((rows) => rows[0]?.total ?? '0');

/** BR-6: the unpaid lines of finalized runs; the age counts from the day the run was finalized. */
export const listUnpaid = (db: Db, today: string) =>
  db.query<UnpaidRow>(
    `select r.id as run_id, r.year, r.month, l.id as line_id, l.worker_id,
            l.net_pay::text as net_pay,
            ($1::date - (r.finalized_at at time zone 'Asia/Karachi')::date)::integer as age_days
       from pyr_lines l join pyr_runs r on r.id = l.run_id
      where l.payment_status = 'unpaid' and r.status in ('finalized', 'part_paid')
        and l.deleted_at is null and r.deleted_at is null
      order by r.year, r.month, l.created_at, l.id`,
    [today],
  );
