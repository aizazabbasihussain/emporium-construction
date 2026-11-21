import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

const DATE = (column: string, alias = column.replace(/^[a-z]+\./, '')) =>
  `to_char(${column}, 'YYYY-MM-DD') as ${alias}`;
const MONEY = (column: string, alias = column.replace(/^[a-z]+\./, '')) =>
  `${column}::text as ${alias}`;

/** A receipt counts from the day it cleared until the day it was cancelled or bounced (BR-8, BR-9). */
const COUNTED = (receipt: string, asOf: string) =>
  `${receipt}.cleared_on is not null and ${receipt}.cleared_on <= ${asOf}::date
   and (${receipt}.cancelled_on is null or ${receipt}.cancelled_on > ${asOf}::date)`;

/* ------------------------------------------------------------------ receipts */

export interface ReceiptRow {
  id: string;
  number: string;
  party_id: string;
  receipt_date: string;
  method: string;
  amount: string;
  account_id: string | null;
  reference: string | null;
  status: string;
  withheld_amount: string;
  withholding_certificate_ref: string | null;
  cashbook_txn_id: string | null;
  reversal_txn_id: string | null;
  cleared_on: string | null;
  cancelled_on: string | null;
  cancel_reason: string | null;
  version: number;
}

const RECEIPT_COLUMNS = `id, number, party_id, ${DATE('receipt_date')}, method, ${MONEY('amount')},
  account_id, reference, status, ${MONEY('withheld_amount')}, withholding_certificate_ref,
  cashbook_txn_id, reversal_txn_id, ${DATE('cleared_on')}, ${DATE('cancelled_on')}, cancel_reason, version`;

export const insertReceipt = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<ReceiptRow>(db, 'rcv_receipts', RECEIPT_COLUMNS, values, by, at);

export const findReceipt = (db: Db, id: string, lock = false) =>
  findRow<ReceiptRow>(db, 'rcv_receipts', RECEIPT_COLUMNS, id, lock);

export const updateReceipt = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<ReceiptRow>(db, 'rcv_receipts', RECEIPT_COLUMNS, id, version, values, by, at);

export async function searchReceipts(
  db: Db,
  q: { partyId?: string | undefined; limit: number; offset: number },
): Promise<{ rows: ReceiptRow[]; total: number }> {
  const params: unknown[] = q.partyId === undefined ? [] : [q.partyId];
  const where = `deleted_at is null ${q.partyId === undefined ? '' : 'and party_id = $1'}`;
  const rows = await db.query<ReceiptRow>(
    `select ${RECEIPT_COLUMNS} from rcv_receipts where ${where}
      order by receipt_date desc, number desc limit ${q.limit} offset ${q.offset}`,
    params,
  );
  const count = await db.query<{ n: string }>(
    `select count(*) as n from rcv_receipts where ${where}`,
    params,
  );
  return { rows, total: Number(count[0]?.n ?? 0) };
}

/* --------------------------------------------------------------- allocations */

export interface AllocationRow {
  id: string;
  receipt_id: string;
  invoice_id: string;
  advance_id: string | null;
  amount: string;
  kind: string;
}

const ALLOCATION_COLUMNS = `id, receipt_id, invoice_id, advance_id, ${MONEY('amount')}, kind`;

export const insertAllocation = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<AllocationRow>(db, 'rcv_allocations', ALLOCATION_COLUMNS, values, by, at, false);

export const listAllocations = (db: Db, receiptId: string) =>
  db.query<AllocationRow>(
    `select ${ALLOCATION_COLUMNS} from rcv_allocations where receipt_id = $1 order by created_at, id`,
    [receiptId],
  );

/* ---------------------------------------------------------------------- pdcs */

export interface PdcRow {
  id: string;
  receipt_id: string;
  party_id: string;
  cheque_number: string;
  bank_name: string;
  drawer: string | null;
  cheque_date: string;
  amount: string;
  status: string;
  deposit_account_id: string | null;
  deposited_on: string | null;
  early_deposit_reason: string | null;
  cleared_on: string | null;
  bounced_on: string | null;
  bounce_reason: string | null;
  replaced_by_pdc_id: string | null;
  version: number;
}

const PDC_TABLE_COLUMNS = `id, receipt_id, cheque_number, bank_name, drawer, ${DATE('cheque_date')},
  ${MONEY('amount')}, status, deposit_account_id, ${DATE('deposited_on')}, early_deposit_reason,
  ${DATE('cleared_on')}, ${DATE('bounced_on')}, bounce_reason, replaced_by_pdc_id, version`;
const PDC_COLUMNS = `${PDC_TABLE_COLUMNS},
  (select r.party_id from rcv_receipts r where r.id = rcv_pdcs.receipt_id) as party_id`;

export const insertPdc = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<PdcRow>(db, 'rcv_pdcs', PDC_COLUMNS, values, by, at);

export const findPdc = (db: Db, id: string, lock = false) =>
  findRow<PdcRow>(db, 'rcv_pdcs', PDC_COLUMNS, id, lock);

export const findPdcByReceipt = (db: Db, receiptId: string) =>
  db
    .query<PdcRow>(`select ${PDC_COLUMNS} from rcv_pdcs where receipt_id = $1`, [receiptId])
    .then((rows) => rows[0]);

export const updatePdc = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<PdcRow>(db, 'rcv_pdcs', PDC_COLUMNS, id, version, values, by, at);

export const listPdcs = (
  db: Db,
  q: { status?: string | undefined; from?: string | undefined; to?: string | undefined },
) => {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (q.status !== undefined) where.push(`status = $${params.push(q.status)}`);
  if (q.from !== undefined) where.push(`cheque_date >= $${params.push(q.from)}::date`);
  if (q.to !== undefined) where.push(`cheque_date <= $${params.push(q.to)}::date`);
  return db.query<PdcRow>(
    `select ${PDC_COLUMNS} from rcv_pdcs where ${where.join(' and ')} order by cheque_date, id`,
    params,
  );
};

/** BR-7: one run per business day. True when this call claimed the day. */
export async function claimReminderRun(db: Db, day: string, dueCount: number): Promise<boolean> {
  const rows = await db.query(
    `insert into rcv_reminder_runs (run_date, due_count) values ($1::date, $2)
     on conflict (run_date) do nothing returning run_date`,
    [day, dueCount],
  );
  return rows.length > 0;
}

/* -------------------------------------------------------------- adjustments */

export interface AdjustmentRow {
  id: string;
  party_id: string;
  invoice_id: string;
  adjustment_date: string;
  amount: string;
  reason: string;
  approval_doc_id: string;
  approved_by: string | null;
}

const ADJUSTMENT_COLUMNS = `id, party_id, invoice_id, ${DATE('adjustment_date')}, ${MONEY('amount')},
  reason, approval_doc_id, approved_by`;

export const insertAdjustment = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<AdjustmentRow>(db, 'rcv_adjustments', ADJUSTMENT_COLUMNS, values, by, at, false);

export const listAdjustments = (db: Db, partyId: string) =>
  db.query<AdjustmentRow>(
    `select ${ADJUSTMENT_COLUMNS} from rcv_adjustments where party_id = $1
      order by adjustment_date, created_at`,
    [partyId],
  );

export const findAdjustmentByApproval = (db: Db, approvalDocId: string) =>
  db
    .query<{ id: string }>('select id from rcv_adjustments where approval_doc_id = $1', [
      approvalDocId,
    ])
    .then((rows) => rows[0]);

/* ---------------------------------------------------------------- follow-ups */

export interface FollowupRow {
  id: string;
  party_id: string;
  invoice_id: string | null;
  pdc_id: string | null;
  due_date: string;
  note: string;
  status: string;
  assigned_to: string | null;
  version: number;
}

const FOLLOWUP_COLUMNS = `id, party_id, invoice_id, pdc_id, ${DATE('due_date')}, note, status,
  assigned_to, version`;

export const insertFollowup = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<FollowupRow>(db, 'rcv_followups', FOLLOWUP_COLUMNS, values, by, at);

export const findFollowup = (db: Db, id: string, lock = false) =>
  findRow<FollowupRow>(db, 'rcv_followups', FOLLOWUP_COLUMNS, id, lock);

export const updateFollowup = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<FollowupRow>(db, 'rcv_followups', FOLLOWUP_COLUMNS, id, version, values, by, at);

export const softDeleteFollowup = (db: Db, id: string, version: number, by: string, at: Date) =>
  updateRow<FollowupRow>(
    db,
    'rcv_followups',
    FOLLOWUP_COLUMNS,
    id,
    version,
    { deleted_at: at.toISOString() },
    by,
    at,
  );

export const listFollowups = (
  db: Db,
  q: { partyId?: string | undefined; status?: string | undefined },
) => {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (q.partyId !== undefined) where.push(`party_id = $${params.push(q.partyId)}`);
  if (q.status !== undefined) where.push(`status = $${params.push(q.status)}`);
  return db.query<FollowupRow>(
    `select ${FOLLOWUP_COLUMNS} from rcv_followups where ${where.join(' and ')}
      order by due_date, id`,
    params,
  );
};

/* ------------------------------------------------------- invoices and ledger */

export interface InvoiceFigures {
  invoice_id: string;
  number: string | null;
  project_id: string;
  party_id: string;
  source_type: string;
  invoice_date: string;
  due_date: string;
  gross: string;
  credited: string;
  withholding_expected: string;
  allocated: string;
  withholding_allocated: string;
  pending: string;
  adjusted: string;
}

/**
 * Issued invoices with what has been collected against each as of a date (BR-1, BR-8). Reads the
 * billing view `bil_v_invoices` and this module's own tables; nothing else.
 */
export function listInvoiceFigures(
  db: Db,
  q: {
    asOf: string;
    partyId?: string | undefined;
    projectId?: string | undefined;
    invoiceIds?: readonly string[] | undefined;
  },
): Promise<InvoiceFigures[]> {
  const params: unknown[] = [q.asOf];
  const where = [`v.status = 'issued'`, 'v.invoice_date <= $1::date'];
  if (q.partyId !== undefined) where.push(`v.party_id = $${params.push(q.partyId)}`);
  if (q.projectId !== undefined) where.push(`v.project_id = $${params.push(q.projectId)}`);
  if (q.invoiceIds !== undefined) where.push(`v.id = any($${params.push(q.invoiceIds)}::uuid[])`);
  return db.query<InvoiceFigures>(
    `select v.id as invoice_id, v.number, v.project_id, v.party_id, v.source_type,
            ${DATE('v.invoice_date')}, ${DATE('v.due_date')},
            ${MONEY('v.gross_total', 'gross')}, ${MONEY('v.credited_total', 'credited')},
            ${MONEY('v.withholding_expected', 'withholding_expected')},
            coalesce((select sum(a.amount) from rcv_allocations a
                        join rcv_receipts r on r.id = a.receipt_id
                       where a.invoice_id = v.id and ${COUNTED('r', '$1')}), 0)::numeric(18,2)::text as allocated,
            coalesce((select sum(a.amount) from rcv_allocations a
                        join rcv_receipts r on r.id = a.receipt_id
                       where a.invoice_id = v.id and a.kind = 'withholding'
                         and ${COUNTED('r', '$1')}), 0)::numeric(18,2)::text as withholding_allocated,
            coalesce((select sum(a.amount) from rcv_allocations a
                        join rcv_receipts r on r.id = a.receipt_id
                       where a.invoice_id = v.id and r.status = 'pending_clearing'), 0)::numeric(18,2)::text as pending,
            coalesce((select sum(j.amount) from rcv_adjustments j
                       where j.invoice_id = v.id and j.adjustment_date <= $1::date), 0)::numeric(18,2)::text as adjusted
       from bil_v_invoices v
      where ${where.join(' and ')}
      order by v.due_date, v.id`,
    params,
  );
}

export interface ReceiptEventRow {
  receipt_id: string;
  number: string;
  cleared_on: string;
  cancelled_on: string | null;
  cash: string;
  withholding: string;
}

/** BR-10: every receipt of a customer that cleared, with its cash and withholding parts. */
export const listReceiptEvents = (db: Db, partyId: string, upTo: string) =>
  db.query<ReceiptEventRow>(
    `select r.id as receipt_id, r.number, ${DATE('r.cleared_on')}, ${DATE('r.cancelled_on')},
            coalesce(sum(a.amount) filter (where a.kind <> 'withholding'), 0)::numeric(18,2)::text as cash,
            coalesce(sum(a.amount) filter (where a.kind = 'withholding'), 0)::numeric(18,2)::text as withholding
       from rcv_receipts r
       join rcv_allocations a on a.receipt_id = r.id
      where r.party_id = $1 and r.cleared_on is not null and r.cleared_on <= $2::date
      group by r.id
      order by r.cleared_on, r.number`,
    [partyId, upTo],
  );

/** Money received and not allocated to any invoice: customer credit (BR-1). */
export const unallocatedReceipts = (db: Db, partyId: string, asOf: string) =>
  db
    .query<{ total: string }>(
      `select coalesce(sum(r.amount + r.withheld_amount - coalesce(
                (select sum(a.amount) from rcv_allocations a where a.receipt_id = r.id), 0)), 0)::numeric(18,2)::text
                as total
         from rcv_receipts r
        where r.party_id = $1 and ${COUNTED('r', '$2')}`,
      [partyId, asOf],
    )
    .then((rows) => rows[0]?.total ?? '0');

/** Advances (billing) that cleared receipts paid, for the unapplied-credit figure (BR-5). */
export const listAdvanceAllocations = (db: Db, partyId: string, asOf: string) =>
  db.query<{ advance_id: string; project_id: string; amount: string }>(
    `select a.advance_id, v.project_id, sum(a.amount)::numeric(18,2)::text as amount
       from rcv_allocations a
       join rcv_receipts r on r.id = a.receipt_id
       join bil_v_invoices v on v.id = a.invoice_id
      where r.party_id = $1 and a.kind = 'advance' and ${COUNTED('r', '$2')}
      group by a.advance_id, v.project_id`,
    [partyId, asOf],
  );

/**
 * What was collected against the invoices of a project as of a date: gross (cash and withholding
 * certified), the part of it that is withholding, and the base (gross less the tax share of each
 * invoice). Advance invoices are left out, as in the billed figure of billing.
 */
export const collectedSplitForProject = (db: Db, projectId: string, asOf: string) =>
  db
    .query<{ gross: string; withheld: string; base: string }>(
      `select coalesce(sum(a.amount), 0)::numeric(18,2)::text as gross,
              coalesce(sum(a.amount) filter (where a.kind = 'withholding'), 0)::numeric(18,2)::text as withheld,
              coalesce(sum(round(a.amount * (v.gross_total - v.tax_total) / v.gross_total, 2))
                       filter (where v.gross_total <> 0), 0)::numeric(18,2)::text as base
         from rcv_allocations a
         join rcv_receipts r on r.id = a.receipt_id
         join bil_v_invoices v on v.id = a.invoice_id
        where v.project_id = $1 and v.source_type <> 'advance' and a.kind <> 'advance'
          and ${COUNTED('r', '$2')}`,
      [projectId, asOf],
    )
    .then((rows) => rows[0] as { gross: string; withheld: string; base: string });

/** What was collected (cash and advances, not withholding) against the invoices of a project. */
export const collectedForProject = (db: Db, projectId: string, asOf: string) =>
  db
    .query<{ total: string }>(
      `select coalesce(sum(a.amount), 0)::numeric(18,2)::text as total
         from rcv_allocations a
         join rcv_receipts r on r.id = a.receipt_id
         join bil_v_invoices v on v.id = a.invoice_id
        where v.project_id = $1 and a.kind <> 'withholding' and ${COUNTED('r', '$2')}`,
      [projectId, asOf],
    )
    .then((rows) => rows[0]?.total ?? '0');
