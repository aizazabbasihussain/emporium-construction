import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

const DATE = (column: string, alias = column.replace(/^[a-z]+\./, '')) =>
  `to_char(${column}, 'YYYY-MM-DD') as ${alias}`;
const MONEY = (column: string, alias = column.replace(/^[a-z]+\./, '')) =>
  `${column}::text as ${alias}`;

/** A payment counts from the day it was paid until the day it was cancelled (BR-9: as of any date). */
const PAYMENT_COUNTED = (payment: string, asOf: string) =>
  `${payment}.paid_on is not null and ${payment}.paid_on <= ${asOf}::date
   and (${payment}.cancelled_on is null or ${payment}.cancelled_on > ${asOf}::date)`;

/** A bill is owed from the day it was posted until the day it was cancelled. */
const BILL_COUNTED = (bill: string, asOf: string) =>
  `${bill}.posted_on is not null and ${bill}.posted_on <= ${asOf}::date
   and (${bill}.cancelled_on is null or ${bill}.cancelled_on > ${asOf}::date)`;

/* ---------------------------------------------------------------------- bills */

export interface BillRow {
  id: string;
  number: string;
  vendor_party_id: string;
  vendor_invoice_no: string;
  bill_date: string;
  due_date: string;
  source_type: string;
  source_doc_id: string | null;
  status: string;
  supply_kind: string;
  nature: string;
  location_id: string | null;
  base_amount: string;
  tax_total: string;
  gross_total: string;
  withholding_total: string;
  net_payable: string;
  tax_snapshot: unknown;
  authority_code: string | null;
  notes: string | null;
  match_override_reason: string | null;
  match_overridden_by: string | null;
  posted_on: string | null;
  posted_by: string | null;
  cancelled_on: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  version: number;
}

const BILL_COLUMNS = `id, number, vendor_party_id, vendor_invoice_no, ${DATE('bill_date')},
  ${DATE('due_date')}, source_type, source_doc_id, status, supply_kind, nature, location_id,
  ${MONEY('base_amount')}, ${MONEY('tax_total')}, ${MONEY('gross_total')},
  ${MONEY('withholding_total')}, ${MONEY('net_payable')}, tax_snapshot, authority_code, notes,
  match_override_reason, match_overridden_by, ${DATE('posted_on')}, posted_by,
  ${DATE('cancelled_on')}, cancel_reason, created_by, version`;

export const insertBill = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<BillRow>(db, 'pay_bills', BILL_COLUMNS, values, by, at);

export const findBill = (db: Db, id: string, lock = false) =>
  findRow<BillRow>(db, 'pay_bills', BILL_COLUMNS, id, lock);

export const updateBill = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<BillRow>(db, 'pay_bills', BILL_COLUMNS, id, version, values, by, at);

/** BR-2: the vendor's own invoice number identifies a bill. */
export const findBillByInvoice = (db: Db, vendorPartyId: string, vendorInvoiceNo: string) =>
  db
    .query<BillRow>(
      `select ${BILL_COLUMNS} from pay_bills where vendor_party_id = $1 and vendor_invoice_no = $2`,
      [vendorPartyId, vendorInvoiceNo],
    )
    .then((rows) => rows[0]);

export async function searchBills(
  db: Db,
  q: {
    vendorPartyId?: string | undefined;
    status?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ rows: BillRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (q.vendorPartyId !== undefined) {
    params.push(q.vendorPartyId);
    where.push(`vendor_party_id = $${params.length}`);
  }
  if (q.status !== undefined) {
    params.push(q.status);
    where.push(`status = $${params.length}`);
  }
  const rows = await db.query<BillRow>(
    `select ${BILL_COLUMNS} from pay_bills where ${where.join(' and ')}
      order by bill_date desc, number desc limit ${q.limit} offset ${q.offset}`,
    params,
  );
  const count = await db.query<{ n: string }>(
    `select count(*) as n from pay_bills where ${where.join(' and ')}`,
    params,
  );
  return { rows, total: Number(count[0]?.n ?? 0) };
}

/* ---------------------------------------------------------------------- lines */

export interface LineRow {
  id: string;
  bill_id: string;
  line_no: number;
  source_doc_type: string | null;
  source_doc_id: string | null;
  po_line_id: string | null;
  grn_line_id: string | null;
  description: string;
  quantity: string;
  rate: string;
  amount: string;
  cost_object_type: string;
  cost_object_id: string | null;
  cost_code_id: string;
  source_entry_id: string | null;
  cost_entry_id: string | null;
}

const LINE_COLUMNS = `id, bill_id, line_no, source_doc_type, source_doc_id, po_line_id, grn_line_id,
  description, ${MONEY('quantity')}, ${MONEY('rate')}, ${MONEY('amount')}, cost_object_type,
  cost_object_id, cost_code_id, source_entry_id, cost_entry_id`;

export interface NewLine {
  id: string;
  lineNo: number;
  sourceDocType: string | null;
  sourceDocId: string | null;
  poLineId: string | null;
  grnLineId: string | null;
  description: string;
  quantity: string;
  rate: string;
  amount: string;
  costObjectType: string;
  costObjectId: string | null;
  costCodeId: string;
  sourceEntryId: string | null;
}

/** Lines are replaced as a whole when a draft is edited. */
export async function replaceLines(db: Db, billId: string, lines: readonly NewLine[]) {
  await db.query(
    'delete from pay_matches where bill_line_id in (select id from pay_bill_lines where bill_id = $1)',
    [billId],
  );
  await db.query('delete from pay_bill_lines where bill_id = $1', [billId]);
  for (const line of lines) {
    await db.query(
      `insert into pay_bill_lines
         (id, bill_id, line_no, source_doc_type, source_doc_id, po_line_id, grn_line_id, description,
          quantity, rate, amount, cost_object_type, cost_object_id, cost_code_id, source_entry_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        line.id,
        billId,
        line.lineNo,
        line.sourceDocType,
        line.sourceDocId,
        line.poLineId,
        line.grnLineId,
        line.description,
        line.quantity,
        line.rate,
        line.amount,
        line.costObjectType,
        line.costObjectId,
        line.costCodeId,
        line.sourceEntryId,
      ],
    );
  }
}

export const listLines = (db: Db, billId: string) =>
  db.query<LineRow>(
    `select ${LINE_COLUMNS} from pay_bill_lines where bill_id = $1 order by line_no`,
    [billId],
  );

export const setLineCostEntry = (db: Db, lineId: string, entryId: string | null) =>
  db.query('update pay_bill_lines set cost_entry_id = $2 where id = $1', [lineId, entryId]);

/* -------------------------------------------------------------------- matches */

export interface MatchRow {
  bill_line_id: string;
  po_rate: string;
  grn_qty: string;
  billed_qty: string;
  billed_rate: string;
  qty_variance: string;
  rate_variance: string;
  within_tolerance: boolean;
}

export interface NewMatch {
  billLineId: string;
  poRate: string;
  grnQty: string;
  billedQty: string;
  billedRate: string;
  qtyVariance: string;
  rateVariance: string;
  withinTolerance: boolean;
}

export async function replaceMatches(db: Db, billId: string, matches: readonly NewMatch[]) {
  await db.query(
    'delete from pay_matches where bill_line_id in (select id from pay_bill_lines where bill_id = $1)',
    [billId],
  );
  for (const m of matches) {
    await db.query(
      `insert into pay_matches (bill_line_id, po_rate, grn_qty, billed_qty, billed_rate, qty_variance,
                                rate_variance, within_tolerance)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        m.billLineId,
        m.poRate,
        m.grnQty,
        m.billedQty,
        m.billedRate,
        m.qtyVariance,
        m.rateVariance,
        m.withinTolerance,
      ],
    );
  }
}

export const listMatches = (db: Db, billId: string) =>
  db.query<MatchRow>(
    `select m.bill_line_id, ${MONEY('m.po_rate')}, ${MONEY('m.grn_qty')}, ${MONEY('m.billed_qty')},
            ${MONEY('m.billed_rate')}, ${MONEY('m.qty_variance')}, ${MONEY('m.rate_variance')},
            m.within_tolerance
       from pay_matches m join pay_bill_lines l on l.id = m.bill_line_id
      where l.bill_id = $1 order by l.line_no`,
    [billId],
  );

/** Quantity of a receipt line billed on other bills that are not cancelled (BR-1). */
export const billedQuantity = (db: Db, grnLineId: string, exceptBillId: string) =>
  db
    .query<{ total: string }>(
      `select coalesce(sum(l.quantity), 0)::text as total
         from pay_bill_lines l join pay_bills b on b.id = l.bill_id
        where l.grn_line_id = $1 and b.id <> $2 and b.status <> 'cancelled'`,
      [grnLineId, exceptBillId],
    )
    .then((rows) => rows[0]?.total ?? '0');

/** BR-8 of procurement: a receipt that a live bill refers to cannot be cancelled. */
export const isGrnBilled = (db: Db, grnId: string) =>
  db
    .query<{ billed: boolean }>(
      `select exists (
         select 1 from pay_bill_lines l join pay_bills b on b.id = l.bill_id
          where l.source_doc_type = 'goods_receipt' and l.source_doc_id = $1 and b.status <> 'cancelled'
       ) as billed`,
      [grnId],
    )
    .then((rows) => rows[0]?.billed === true);

/** Another live posted bill already confirmed the cost of this receipt line. */
export const receiptCostConfirmed = (db: Db, grnLineId: string, exceptBillId: string) =>
  db
    .query<{ confirmed: boolean }>(
      `select exists (
         select 1 from pay_bill_lines l join pay_bills b on b.id = l.bill_id
          where l.grn_line_id = $1 and b.id <> $2 and l.cost_entry_id is not null
            and b.status in ('posted', 'partly_paid', 'paid')
       ) as confirmed`,
      [grnLineId, exceptBillId],
    )
    .then((rows) => rows[0]?.confirmed === true);

/** BR-10: another live posted bill still relies on the receipt cost this bill confirmed. */
export const receiptSharedByOthers = (db: Db, billId: string) =>
  db
    .query<{ shared: boolean }>(
      `select exists (
         select 1 from pay_bill_lines mine
           join pay_bill_lines other on other.grn_line_id = mine.grn_line_id and other.bill_id <> mine.bill_id
           join pay_bills b on b.id = other.bill_id
          where mine.bill_id = $1 and mine.cost_entry_id is not null
            and b.status in ('posted', 'partly_paid', 'paid')
       ) as shared`,
      [billId],
    )
    .then((rows) => rows[0]?.shared === true);

/** Value of the lines of a bill that the receipts cover (for the commitments warning, BR-2). */
export const coveredValue = (db: Db, billId: string) =>
  db
    .query<{ total: string }>(
      `select coalesce(sum(round((l.quantity - m.qty_variance) * m.po_rate, 2)), 0)::text as total
         from pay_matches m join pay_bill_lines l on l.id = m.bill_line_id
        where l.bill_id = $1`,
      [billId],
    )
    .then((rows) => rows[0]?.total ?? '0');

/* ------------------------------------------------------------------ variances */

export interface VarianceRow {
  id: string;
  bill_id: string;
  bill_line_id: string;
  cost_object_type: string;
  cost_object_id: string | null;
  amount: string;
  treatment: string;
  ledger_entry_id: string;
  reversed_on: string | null;
}

const VARIANCE_COLUMNS = `id, bill_id, bill_line_id, cost_object_type, cost_object_id,
  ${MONEY('amount')}, treatment, ledger_entry_id, ${DATE('reversed_on')}`;

export const insertVariance = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<VarianceRow>(db, 'pay_variances', VARIANCE_COLUMNS, values, by, at, false);

export const listVariances = (db: Db, billId: string) =>
  db.query<VarianceRow>(
    `select ${VARIANCE_COLUMNS} from pay_variances where bill_id = $1 order by created_at, id`,
    [billId],
  );

export const markVarianceReversed = (db: Db, id: string, on: string) =>
  db.query('update pay_variances set reversed_on = $2 where id = $1', [id, on]);

/* ------------------------------------------------------------------- payments */

export interface PaymentRow {
  id: string;
  number: string;
  vendor_party_id: string;
  payment_date: string;
  method: string;
  amount: string;
  withholding_deducted: string;
  account_id: string;
  cheque_number: string | null;
  cheque_date: string | null;
  status: string;
  approval_request_id: string | null;
  approval_doc_id: string | null;
  run_id: string | null;
  reference: string | null;
  withholding_certificate_no: string | null;
  paid_on: string | null;
  paid_by: string | null;
  cashbook_txn_id: string | null;
  reversal_txn_id: string | null;
  cancelled_on: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  version: number;
}

const PAYMENT_COLUMNS = `id, number, vendor_party_id, ${DATE('payment_date')}, method,
  ${MONEY('amount')}, ${MONEY('withholding_deducted')}, account_id, cheque_number,
  ${DATE('cheque_date')}, status, approval_request_id, approval_doc_id, run_id, reference,
  withholding_certificate_no, ${DATE('paid_on')}, paid_by, cashbook_txn_id, reversal_txn_id,
  ${DATE('cancelled_on')}, cancel_reason, created_by, version`;

export const insertPayment = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<PaymentRow>(db, 'pay_payments', PAYMENT_COLUMNS, values, by, at);

export const findPayment = (db: Db, id: string, lock = false) =>
  findRow<PaymentRow>(db, 'pay_payments', PAYMENT_COLUMNS, id, lock);

export const updatePayment = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<PaymentRow>(db, 'pay_payments', PAYMENT_COLUMNS, id, version, values, by, at);

export async function searchPayments(
  db: Db,
  q: {
    vendorPartyId?: string | undefined;
    status?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ rows: PaymentRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (q.vendorPartyId !== undefined) {
    params.push(q.vendorPartyId);
    where.push(`vendor_party_id = $${params.length}`);
  }
  if (q.status !== undefined) {
    params.push(q.status);
    where.push(`status = $${params.length}`);
  }
  const rows = await db.query<PaymentRow>(
    `select ${PAYMENT_COLUMNS} from pay_payments where ${where.join(' and ')}
      order by payment_date desc, number desc limit ${q.limit} offset ${q.offset}`,
    params,
  );
  const count = await db.query<{ n: string }>(
    `select count(*) as n from pay_payments where ${where.join(' and ')}`,
    params,
  );
  return { rows, total: Number(count[0]?.n ?? 0) };
}

export const listPaymentsByRun = (db: Db, runId: string) =>
  db.query<PaymentRow>(
    `select ${PAYMENT_COLUMNS} from pay_payments where run_id = $1 and deleted_at is null
      order by number`,
    [runId],
  );

export interface RunRow {
  id: string;
  run_date: string;
  total: string;
  note: string | null;
}

const RUN_COLUMNS = `id, ${DATE('run_date')}, ${MONEY('total')}, note`;

export const insertRun = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<RunRow>(db, 'pay_payment_runs', RUN_COLUMNS, values, by, at, false);

export const findRun = (db: Db, id: string) =>
  db
    .query<RunRow>(`select ${RUN_COLUMNS} from pay_payment_runs where id = $1`, [id])
    .then((rows) => rows[0]);

/** Cheques issued with a later date and not yet in the cash book (BR-7). */
export const findDueCheques = (db: Db, today: string) =>
  db.query<PaymentRow>(
    `select ${PAYMENT_COLUMNS} from pay_payments
      where status = 'paid' and method = 'cheque' and cashbook_txn_id is null
        and cheque_date <= $1::date and deleted_at is null
      order by cheque_date, number`,
    [today],
  );

/* ---------------------------------------------------------------- allocations */

export interface AllocationRow {
  id: string;
  payment_id: string;
  bill_id: string;
  amount: string;
  withholding: string;
}

const ALLOCATION_COLUMNS = `id, payment_id, bill_id, ${MONEY('amount')}, ${MONEY('withholding')}`;

export const insertAllocation = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<AllocationRow>(
    db,
    'pay_payment_allocations',
    ALLOCATION_COLUMNS,
    values,
    by,
    at,
    false,
  );

export const listAllocations = (db: Db, paymentId: string) =>
  db.query<AllocationRow>(
    `select ${ALLOCATION_COLUMNS} from pay_payment_allocations where payment_id = $1
      order by created_at, id`,
    [paymentId],
  );

/** BR-10: a payment that is not cancelled has allocated money to the bill. */
export const hasLiveAllocations = (db: Db, billId: string) =>
  db
    .query<{ live: boolean }>(
      `select exists (
         select 1 from pay_payment_allocations a join pay_payments p on p.id = a.payment_id
          where a.bill_id = $1 and p.status <> 'cancelled'
       ) as live`,
      [billId],
    )
    .then((rows) => rows[0]?.live === true);

export interface OpenBillRow {
  bill_id: string;
  number: string;
  vendor_invoice_no: string;
  vendor_party_id: string;
  bill_date: string;
  due_date: string;
  gross: string;
  withholding_total: string;
  allocated: string;
  withheld: string;
  /** Allocated by payments that are not yet paid (draft, pending, approved): reserved. */
  reserved: string;
  /** The withholding of those reserved allocations. */
  reserved_withholding: string;
}

/**
 * Posted bills with what payments counted on `asOf` have taken. Payments that are drafted, waiting
 * for approval or approved reserve their allocations so two payments cannot take the same money.
 */
export function listBillFigures(
  db: Db,
  q: { asOf: string; vendorPartyId?: string | undefined; billIds?: readonly string[] | undefined },
) {
  const params: unknown[] = [q.asOf];
  const where = [BILL_COUNTED('b', '$1')];
  if (q.vendorPartyId !== undefined) {
    params.push(q.vendorPartyId);
    where.push(`b.vendor_party_id = $${params.length}`);
  }
  if (q.billIds !== undefined) {
    params.push(q.billIds);
    where.push(`b.id = any($${params.length}::uuid[])`);
  }
  return db.query<OpenBillRow>(
    `select b.id as bill_id, b.number, b.vendor_invoice_no, b.vendor_party_id,
            to_char(b.bill_date, 'YYYY-MM-DD') as bill_date, to_char(b.due_date, 'YYYY-MM-DD') as due_date,
            b.gross_total::text as gross, b.withholding_total::text as withholding_total,
            coalesce((select sum(a.amount) from pay_payment_allocations a
                       join pay_payments p on p.id = a.payment_id
                      where a.bill_id = b.id and ${PAYMENT_COUNTED('p', '$1')}), 0)::text as allocated,
            coalesce((select sum(a.withholding) from pay_payment_allocations a
                       join pay_payments p on p.id = a.payment_id
                      where a.bill_id = b.id and ${PAYMENT_COUNTED('p', '$1')}), 0)::text as withheld,
            coalesce((select sum(a.amount) from pay_payment_allocations a
                       join pay_payments p on p.id = a.payment_id
                      where a.bill_id = b.id and p.status in ('draft', 'pending_approval', 'approved')), 0)::text
              as reserved,
            coalesce((select sum(a.withholding) from pay_payment_allocations a
                       join pay_payments p on p.id = a.payment_id
                      where a.bill_id = b.id and p.status in ('draft', 'pending_approval', 'approved')), 0)::text
              as reserved_withholding
       from pay_bills b
      where ${where.join(' and ')}
      order by b.due_date, b.number`,
    params,
  );
}

/**
 * P2-01 BR-8: the rows of the tax report of one authority in a date range. Input tax comes from the
 * bills posted in it (a cancelled bill is out); withholding we deducted from the payments paid in it.
 */
export const taxReportRows = (db: Db, query: { authorityCode: string; from: string; to: string }) =>
  db.query<{ documentId: string; kind: string; date: string; base: string; tax: string }>(
    `select b.id::text as "documentId", 'vendor_bill' as kind,
            to_char(b.posted_on, 'YYYY-MM-DD') as date, b.base_amount::text as base,
            b.tax_total::text as tax
       from pay_bills b
      where b.status in ('posted', 'partly_paid', 'paid') and b.authority_code = $1
        and b.posted_on between $2 and $3 and b.deleted_at is null
     union all
     select p.id::text, 'withholding_deducted', to_char(p.paid_on, 'YYYY-MM-DD'),
            sum(a.amount)::text, sum(a.withholding)::text
       from pay_payment_allocations a
       join pay_payments p on p.id = a.payment_id
       join pay_bills b on b.id = a.bill_id
      where a.withholding > 0 and p.paid_on is not null and p.cancelled_on is null
        and b.authority_code = $1 and p.paid_on between $2 and $3
      group by p.id, p.paid_on
      order by date, "documentId"`,
    [query.authorityCode, query.from, query.to],
  );

/** Gross allocated to bills of one source document by payments that count today (P2-06 reads this). */
export const paidAgainstSource = (db: Db, sourceType: string, sourceDocId: string, asOf: string) =>
  db
    .query<{ total: string }>(
      `select coalesce(sum(a.amount), 0)::numeric(18,2)::text as total
         from pay_payment_allocations a
         join pay_payments p on p.id = a.payment_id
         join pay_bills b on b.id = a.bill_id
        where b.source_type = $1 and b.source_doc_id = $2 and ${PAYMENT_COUNTED('p', '$3')}`,
      [sourceType, sourceDocId, asOf],
    )
    .then((rows) => rows[0]?.total ?? '0');

/**
 * Cash paid to vendors and subcontractors for a project as of a date. A payment's share for the
 * project is its allocation to each bill times the project's part of that bill's lines.
 */
export const paidForProject = (db: Db, projectId: string, asOf: string) =>
  db
    .query<{ total: string }>(
      `select coalesce(sum(round(a.amount * s.share, 2)), 0)::numeric(18,2)::text as total
         from pay_payment_allocations a
         join pay_payments p on p.id = a.payment_id
         join (select bill_id,
                      sum(amount) filter (where cost_object_type = 'project' and cost_object_id = $1)
                        / nullif(sum(amount), 0) as share
                 from pay_bill_lines group by bill_id) s on s.bill_id = a.bill_id
        where s.share is not null and ${PAYMENT_COUNTED('p', '$2')}`,
      [projectId, asOf],
    )
    .then((rows) => rows[0]?.total ?? '0');

/** The ledger lines of a vendor up to a date, oldest first (BR-9). */
export interface LedgerRow {
  kind: string;
  document_id: string;
  reference: string;
  entry_date: string;
  debit: string;
  credit: string;
}

export const listLedgerRows = (db: Db, vendorPartyId: string, from: string, to: string) =>
  db.query<LedgerRow>(
    `select kind, document_id, reference, to_char(entry_date, 'YYYY-MM-DD') as entry_date,
            debit::text as debit, credit::text as credit
       from (
         select 'bill'::text as kind, b.id as document_id, b.number as reference, b.posted_on as entry_date,
                0::numeric(18,2) as debit, b.gross_total as credit
           from pay_bills b
          where b.vendor_party_id = $1 and ${BILL_COUNTED('b', '$3')}
         union all
         select 'payment', p.id, p.number, p.paid_on,
                (select coalesce(sum(a.amount), 0) from pay_payment_allocations a where a.payment_id = p.id),
                0::numeric(18,2)
           from pay_payments p
          where p.vendor_party_id = $1 and ${PAYMENT_COUNTED('p', '$3')}
       ) x
      where entry_date between $2::date and $3::date
      order by entry_date, kind, reference`,
    [vendorPartyId, from, to],
  );

/** BR-9: the figures behind a balance on one date. */
export async function balanceFigures(db: Db, vendorPartyId: string, asOf: string) {
  const bills = await db.query<{ net_payable: string; withholding_total: string }>(
    `select b.net_payable::text, b.withholding_total::text from pay_bills b
      where b.vendor_party_id = $1 and ${BILL_COUNTED('b', '$2')}`,
    [vendorPartyId, asOf],
  );
  const allocations = await db.query<{ amount: string }>(
    `select a.amount::text from pay_payment_allocations a
       join pay_payments p on p.id = a.payment_id
       join pay_bills b on b.id = a.bill_id
      where p.vendor_party_id = $1 and ${PAYMENT_COUNTED('p', '$2')}`,
    [vendorPartyId, asOf],
  );
  return { bills, allocations: allocations.map((a) => a.amount) };
}

export interface WithholdingRow {
  authority_code: string | null;
  payment_id: string;
  payment_number: string;
  vendor_party_id: string;
  paid_on: string;
  bill_id: string;
  bill_number: string;
  amount: string;
  certificate_no: string | null;
}

/** BR-8: withholding deducted per authority and month, from payments that count. */
export const listWithholding = (
  db: Db,
  q: { from: string; to: string; authorityCode?: string | undefined },
) =>
  db.query<WithholdingRow>(
    `select b.authority_code, p.id as payment_id, p.number as payment_number, p.vendor_party_id,
            to_char(p.paid_on, 'YYYY-MM-DD') as paid_on, b.id as bill_id, b.number as bill_number,
            a.withholding::text as amount, p.withholding_certificate_no as certificate_no
       from pay_payment_allocations a
       join pay_payments p on p.id = a.payment_id
       join pay_bills b on b.id = a.bill_id
      where a.withholding > 0 and p.paid_on is not null and p.cancelled_on is null
        and p.paid_on between $1::date and $2::date
        and ($3::text is null or b.authority_code = $3)
      order by b.authority_code, p.paid_on, p.number`,
    [q.from, q.to, q.authorityCode ?? null],
  );
