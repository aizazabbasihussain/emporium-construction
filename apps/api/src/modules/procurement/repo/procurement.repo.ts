import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

const DATE = (column: string) => `to_char(${column}, 'YYYY-MM-DD') as ${column}`;

/* ---------------------------------------------------------------- counters */

/** BR numbering: the next number of a kind and year, taken under a row lock in the caller's transaction. */
export async function nextSeq(db: Db, kind: string, year: number): Promise<number> {
  const rows = await db.query<{ last_seq: number }>(
    `insert into prc_counters (kind, year, last_seq) values ($1, $2, 1)
     on conflict (kind, year) do update set last_seq = prc_counters.last_seq + 1
     returning last_seq`,
    [kind, year],
  );
  return (rows[0] as { last_seq: number }).last_seq;
}

/* ------------------------------------------------------------ requisitions */

export interface RequisitionRow {
  id: string;
  number: string;
  project_id: string | null;
  store_id: string | null;
  requested_by: string;
  required_by: string | null;
  status: string;
  note: string;
  version: number;
}

const REQ_COLUMNS = `id, number, project_id, store_id, requested_by, ${DATE('required_by')}, status, note, version`;

export const insertRequisition = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<RequisitionRow>(db, 'prc_requisitions', REQ_COLUMNS, values, by, at);

export const updateRequisition = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<RequisitionRow>(db, 'prc_requisitions', REQ_COLUMNS, id, version, values, by, at);

export const findRequisition = (db: Db, id: string, lock = false) =>
  findRow<RequisitionRow>(db, 'prc_requisitions', REQ_COLUMNS, id, lock);

export interface RequisitionSearch {
  status?: string | undefined;
  projectId?: string | undefined;
  storeId?: string | undefined;
  /** Scope-limited callers see only these projects (BR-12). */
  projectIds?: readonly string[] | undefined;
  limit: number;
  offset: number;
}

export interface RequisitionLineRow {
  id: string;
  line_no: number;
  item_id: string;
  description: string;
  quantity: string;
  unit_code: string;
  cost_code_id: string;
  estimated_rate: string | null;
}

const REQ_LINE_COLUMNS = `id, line_no, item_id, description, quantity::text as quantity, unit_code,
  cost_code_id, estimated_rate::text as estimated_rate`;

export async function searchRequisitions(
  db: Db,
  search: RequisitionSearch,
): Promise<{ rows: RequisitionRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (search.status !== undefined) add('status = ?', search.status);
  if (search.projectId !== undefined) add('project_id = ?', search.projectId);
  if (search.storeId !== undefined) add('store_id = ?', search.storeId);
  if (search.projectIds !== undefined) add('project_id = any(?::uuid[])', search.projectIds);
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from prc_requisitions where ${filter}`,
    params,
  );
  const rows = await db.query<RequisitionRow>(
    `select ${REQ_COLUMNS} from prc_requisitions where ${filter}
      order by created_at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

export const listRequisitionLines = (db: Db, requisitionId: string) =>
  db.query<RequisitionLineRow>(
    `select ${REQ_LINE_COLUMNS} from prc_requisition_lines where requisition_id = $1 order by line_no`,
    [requisitionId],
  );

export async function findRequisitionLine(
  db: Db,
  id: string,
): Promise<(RequisitionLineRow & { requisition_id: string }) | undefined> {
  const rows = await db.query<RequisitionLineRow & { requisition_id: string }>(
    `select ${REQ_LINE_COLUMNS}, requisition_id from prc_requisition_lines where id = $1`,
    [id],
  );
  return rows[0];
}

export async function replaceRequisitionLines(
  db: Db,
  requisitionId: string,
  lines: readonly (Omit<RequisitionLineRow, 'id'> & { id: string })[],
): Promise<void> {
  await db.query('delete from prc_requisition_lines where requisition_id = $1', [requisitionId]);
  for (const line of lines) {
    await db.query(
      `insert into prc_requisition_lines
         (id, requisition_id, line_no, item_id, description, quantity, unit_code, cost_code_id, estimated_rate)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        line.id,
        requisitionId,
        line.line_no,
        line.item_id,
        line.description,
        line.quantity,
        line.unit_code,
        line.cost_code_id,
        line.estimated_rate,
      ],
    );
  }
}

/** Quantity of each requisition line that is on a purchase order that is not cancelled. */
export async function orderedByLine(db: Db, requisitionId: string): Promise<Map<string, string>> {
  const rows = await db.query<{ requisition_line_id: string; ordered: string }>(
    `select l.requisition_line_id, sum(l.quantity)::text as ordered
       from prc_po_lines l join prc_purchase_orders p on p.id = l.po_id
      where p.requisition_id = $1 and p.deleted_at is null and p.status <> 'cancelled'
        and l.removed = false and l.requisition_line_id is not null
      group by l.requisition_line_id`,
    [requisitionId],
  );
  return new Map(rows.map((row) => [row.requisition_line_id, row.ordered]));
}

/* ------------------------------------------------------------------- RFQs */

export interface RfqRow {
  id: string;
  requisition_id: string;
  number: string;
  status: string;
  version: number;
}

const RFQ_COLUMNS = 'id, requisition_id, number, status, version';

export const insertRfq = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<RfqRow>(db, 'prc_rfqs', RFQ_COLUMNS, values, by, at);

export const updateRfq = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<RfqRow>(db, 'prc_rfqs', RFQ_COLUMNS, id, version, values, by, at);

export const findRfq = (db: Db, id: string, lock = false) =>
  findRow<RfqRow>(db, 'prc_rfqs', RFQ_COLUMNS, id, lock);

export async function searchRfqs(
  db: Db,
  search: { requisitionId?: string | undefined; limit: number; offset: number },
): Promise<{ rows: RfqRow[]; total: number }> {
  const params: unknown[] = [];
  let filter = 'deleted_at is null';
  if (search.requisitionId !== undefined) {
    params.push(search.requisitionId);
    filter += ` and requisition_id = $${params.length}`;
  }
  const total = await db.query<{ total: string }>(
    `select count(*) as total from prc_rfqs where ${filter}`,
    params,
  );
  const rows = await db.query<RfqRow>(
    `select ${RFQ_COLUMNS} from prc_rfqs where ${filter}
      order by created_at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

export async function setRfqVendors(db: Db, rfqId: string, vendorIds: readonly string[]) {
  for (const vendorId of vendorIds) {
    await db.query('insert into prc_rfq_vendors (rfq_id, vendor_id) values ($1, $2)', [
      rfqId,
      vendorId,
    ]);
  }
}

export async function listRfqVendors(db: Db, rfqId: string): Promise<string[]> {
  const rows = await db.query<{ vendor_id: string }>(
    'select vendor_id from prc_rfq_vendors where rfq_id = $1 order by vendor_id',
    [rfqId],
  );
  return rows.map((row) => row.vendor_id);
}

export interface QuoteRow {
  id: string;
  rfq_id: string;
  vendor_id: string;
  valid_until: string | null;
  delivery_days: number | null;
  terms: string;
  total: string;
  version: number;
}

const QUOTE_COLUMNS = `id, rfq_id, vendor_id, ${DATE('valid_until')}, delivery_days, terms,
  total::text as total, version`;

export const insertQuote = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<QuoteRow>(db, 'prc_quotes', QUOTE_COLUMNS, values, by, at);

export const updateQuote = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<QuoteRow>(db, 'prc_quotes', QUOTE_COLUMNS, id, version, values, by, at);

export const findQuote = (db: Db, id: string, lock = false) =>
  findRow<QuoteRow>(db, 'prc_quotes', QUOTE_COLUMNS, id, lock);

export const listQuotes = (db: Db, rfqId: string) =>
  db.query<QuoteRow>(
    `select ${QUOTE_COLUMNS} from prc_quotes where rfq_id = $1 and deleted_at is null
      order by created_at, id`,
    [rfqId],
  );

export const findQuoteOfVendor = async (db: Db, rfqId: string, vendorId: string) =>
  (
    await db.query<QuoteRow>(
      `select ${QUOTE_COLUMNS} from prc_quotes
        where rfq_id = $1 and vendor_id = $2 and deleted_at is null`,
      [rfqId, vendorId],
    )
  )[0];

export interface QuoteLineRow {
  quote_id: string;
  requisition_line_id: string;
  rate: string;
}

export async function replaceQuoteLines(
  db: Db,
  quoteId: string,
  lines: readonly { requisitionLineId: string; rate: string }[],
): Promise<void> {
  await db.query('delete from prc_quote_lines where quote_id = $1', [quoteId]);
  for (const line of lines) {
    await db.query(
      'insert into prc_quote_lines (quote_id, requisition_line_id, rate) values ($1, $2, $3)',
      [quoteId, line.requisitionLineId, line.rate],
    );
  }
}

/** All lines of the live quotes of one RFQ. */
export const listQuoteLines = (db: Db, rfqId: string) =>
  db.query<QuoteLineRow>(
    `select ql.quote_id, ql.requisition_line_id, ql.rate::text as rate
       from prc_quote_lines ql join prc_quotes q on q.id = ql.quote_id
      where q.rfq_id = $1 and q.deleted_at is null`,
    [rfqId],
  );

export interface SelectionRow {
  requisition_line_id: string;
  quote_id: string;
  reason: string | null;
}

export async function upsertSelection(
  db: Db,
  rfqId: string,
  requisitionLineId: string,
  quoteId: string,
  reason: string | null,
): Promise<void> {
  await db.query(
    `insert into prc_selections (rfq_id, requisition_line_id, quote_id, reason)
     values ($1, $2, $3, $4)
     on conflict (rfq_id, requisition_line_id)
     do update set quote_id = excluded.quote_id, reason = excluded.reason`,
    [rfqId, requisitionLineId, quoteId, reason],
  );
}

export const listSelections = (db: Db, rfqId: string) =>
  db.query<SelectionRow>(
    'select requisition_line_id, quote_id, reason from prc_selections where rfq_id = $1',
    [rfqId],
  );

/* --------------------------------------------------------- purchase orders */

export interface PoRow {
  id: string;
  number: string;
  revision: number;
  vendor_id: string;
  requisition_id: string | null;
  project_id: string | null;
  store_id: string | null;
  destination_type: string;
  order_date: string;
  expected_date: string | null;
  status: string;
  total: string;
  terms: string;
  version: number;
}

const PO_COLUMNS = `id, number, revision, vendor_id, requisition_id, project_id, store_id,
  destination_type, ${DATE('order_date')}, ${DATE('expected_date')}, status, total::text as total,
  terms, version`;

export const insertPo = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<PoRow>(db, 'prc_purchase_orders', PO_COLUMNS, values, by, at);

export const updatePo = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<PoRow>(db, 'prc_purchase_orders', PO_COLUMNS, id, version, values, by, at);

export const findPo = (db: Db, id: string, lock = false) =>
  findRow<PoRow>(db, 'prc_purchase_orders', PO_COLUMNS, id, lock);

export interface PoSearch {
  status?: string | undefined;
  vendorId?: string | undefined;
  projectId?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchPos(
  db: Db,
  search: PoSearch,
): Promise<{ rows: PoRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (search.status !== undefined) add('status = ?', search.status);
  if (search.vendorId !== undefined) add('vendor_id = ?', search.vendorId);
  if (search.projectId !== undefined) add('project_id = ?', search.projectId);
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from prc_purchase_orders where ${filter}`,
    params,
  );
  const rows = await db.query<PoRow>(
    `select ${PO_COLUMNS} from prc_purchase_orders where ${filter}
      order by created_at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

export interface PoLineRow {
  id: string;
  po_id: string;
  line_no: number;
  requisition_line_id: string | null;
  item_id: string;
  description: string;
  quantity: string;
  unit_code: string;
  rate: string;
  line_total: string;
  cost_code_id: string;
  received_qty: string;
  removed: boolean;
  commit_entry_id: string | null;
  commit_seq: number;
}

const PO_LINE_COLUMNS = `id, po_id, line_no, requisition_line_id, item_id, description,
  quantity::text as quantity, unit_code, rate::text as rate, line_total::text as line_total,
  cost_code_id, received_qty::text as received_qty, removed, commit_entry_id, commit_seq`;

export const listPoLines = (db: Db, poId: string, options: { withRemoved?: boolean } = {}) =>
  db.query<PoLineRow>(
    `select ${PO_LINE_COLUMNS} from prc_po_lines
      where po_id = $1 ${options.withRemoved === true ? '' : 'and removed = false'} order by line_no`,
    [poId],
  );

export async function findPoLine(db: Db, id: string, lock = false): Promise<PoLineRow | undefined> {
  const rows = await db.query<PoLineRow>(
    `select ${PO_LINE_COLUMNS} from prc_po_lines where id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0];
}

export interface PoLineValues {
  id: string;
  lineNo: number;
  requisitionLineId: string | null;
  itemId: string;
  description: string;
  quantity: string;
  unitCode: string;
  rate: string;
  lineTotal: string;
  costCodeId: string;
}

export async function insertPoLine(db: Db, poId: string, line: PoLineValues): Promise<void> {
  await db.query(
    `insert into prc_po_lines
       (id, po_id, line_no, requisition_line_id, item_id, description, quantity, unit_code, rate,
        line_total, cost_code_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      line.id,
      poId,
      line.lineNo,
      line.requisitionLineId,
      line.itemId,
      line.description,
      line.quantity,
      line.unitCode,
      line.rate,
      line.lineTotal,
      line.costCodeId,
    ],
  );
}

/** Changes the content of an existing line; the quantity received and the commitment stay. */
export async function updatePoLine(db: Db, id: string, line: Omit<PoLineValues, 'id'>) {
  await db.query(
    `update prc_po_lines
        set line_no = $2, requisition_line_id = $3, item_id = $4, description = $5, quantity = $6,
            unit_code = $7, rate = $8, line_total = $9, cost_code_id = $10, removed = false
      where id = $1`,
    [
      id,
      line.lineNo,
      line.requisitionLineId,
      line.itemId,
      line.description,
      line.quantity,
      line.unitCode,
      line.rate,
      line.lineTotal,
      line.costCodeId,
    ],
  );
}

export const deletePoLine = (db: Db, id: string) =>
  db.query('delete from prc_po_lines where id = $1', [id]);

/** BR-5: a line dropped by an amendment keeps its commitment until the amendment is approved. */
export const markPoLineRemoved = (db: Db, id: string) =>
  db.query('update prc_po_lines set removed = true where id = $1', [id]);

/**
 * Moves the line numbers of the lines on the order out of the way before they are renumbered. The
 * shift is larger than every number in use and every number about to be assigned, so no row
 * meets another while the statement runs.
 */
export const shiftPoLineNumbers = (db: Db, poId: string, newCount: number) =>
  db.query(
    `update prc_po_lines
        set line_no = line_no + $2 + (select coalesce(max(line_no), 0) from prc_po_lines
                                       where po_id = $1 and removed = false)
      where po_id = $1 and removed = false`,
    [poId, newCount],
  );

export const setPoLineCommitment = (db: Db, id: string, entryId: string | null, seq: number) =>
  db.query('update prc_po_lines set commit_entry_id = $2, commit_seq = $3 where id = $1', [
    id,
    entryId,
    seq,
  ]);

export const setPoLineReceived = (db: Db, id: string, receivedQty: string) =>
  db.query('update prc_po_lines set received_qty = $2 where id = $1', [id, receivedQty]);

export interface OpenLineRow {
  po_id: string;
  po_number: string;
  vendor_id: string;
  line_id: string;
  line_no: number;
  item_id: string;
  quantity: string;
  received_qty: string;
  rate: string;
  expected_date: string | null;
  destination_type: string;
  project_id: string | null;
  store_id: string | null;
}

/** Lines of approved and partly received orders that still have quantity to come. */
export const listOpenLines = (
  db: Db,
  filter: {
    vendorId?: string | undefined;
    projectId?: string | undefined;
    storeId?: string | undefined;
  },
) => {
  const params: unknown[] = [];
  const where = [
    `p.deleted_at is null`,
    `p.status in ('approved', 'partly_received')`,
    `l.removed = false`,
    `l.received_qty < l.quantity`,
  ];
  for (const [column, value] of [
    ['p.vendor_id', filter.vendorId],
    ['p.project_id', filter.projectId],
    ['p.store_id', filter.storeId],
  ] as const) {
    if (value !== undefined) {
      params.push(value);
      where.push(`${column} = $${params.length}`);
    }
  }
  return db.query<OpenLineRow>(
    `select p.id as po_id, p.number as po_number, p.vendor_id, l.id as line_id, l.line_no,
            l.item_id, l.quantity::text as quantity, l.received_qty::text as received_qty,
            l.rate::text as rate, to_char(p.expected_date, 'YYYY-MM-DD') as expected_date,
            p.destination_type, p.project_id, p.store_id
       from prc_po_lines l join prc_purchase_orders p on p.id = l.po_id
      where ${where.join(' and ')}
      order by p.number, l.line_no`,
    params,
  );
};

/* ---------------------------------------------------------------- receipts */

export interface GrnRow {
  id: string;
  number: string;
  po_id: string;
  received_on: string;
  received_by: string;
  delivery_note_ref: string | null;
  status: string;
  cancel_reason: string | null;
  version: number;
}

const GRN_COLUMNS = `id, number, po_id, ${DATE('received_on')}, received_by, delivery_note_ref,
  status, cancel_reason, version`;

export const insertGrn = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<GrnRow>(db, 'prc_grns', GRN_COLUMNS, values, by, at);

export const updateGrn = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<GrnRow>(db, 'prc_grns', GRN_COLUMNS, id, version, values, by, at);

export const findGrn = (db: Db, id: string, lock = false) =>
  findRow<GrnRow>(db, 'prc_grns', GRN_COLUMNS, id, lock);

export interface GrnSearch {
  poId?: string | undefined;
  status?: string | undefined;
  /** Scope-limited callers see only receipts of orders to these projects (BR-12). */
  projectIds?: readonly string[] | undefined;
  limit: number;
  offset: number;
}

export async function searchGrns(
  db: Db,
  search: GrnSearch,
): Promise<{ rows: GrnRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (search.poId !== undefined) add('po_id = ?', search.poId);
  if (search.status !== undefined) add('status = ?', search.status);
  if (search.projectIds !== undefined) {
    add(
      'po_id in (select id from prc_purchase_orders where project_id = any(?::uuid[]))',
      search.projectIds,
    );
  }
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from prc_grns where ${filter}`,
    params,
  );
  const rows = await db.query<GrnRow>(
    `select ${GRN_COLUMNS} from prc_grns where ${filter}
      order by created_at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

export interface GrnLineRow {
  id: string;
  grn_id: string;
  po_line_id: string;
  accepted_qty: string;
  rejected_qty: string;
  note: string;
  cost_amount: string;
  cost_entry_id: string | null;
}

const GRN_LINE_COLUMNS = `id, grn_id, po_line_id, accepted_qty::text as accepted_qty,
  rejected_qty::text as rejected_qty, note, cost_amount::text as cost_amount, cost_entry_id`;

export const listGrnLines = (db: Db, grnId: string) =>
  db.query<GrnLineRow>(
    `select ${GRN_LINE_COLUMNS} from prc_grn_lines where grn_id = $1 order by id`,
    [grnId],
  );

export async function insertGrnLine(
  db: Db,
  line: {
    id: string;
    grnId: string;
    poLineId: string;
    acceptedQty: string;
    rejectedQty: string;
    note: string;
    costAmount: string;
    costEntryId: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into prc_grn_lines
       (id, grn_id, po_line_id, accepted_qty, rejected_qty, note, cost_amount, cost_entry_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      line.id,
      line.grnId,
      line.poLineId,
      line.acceptedQty,
      line.rejectedQty,
      line.note,
      line.costAmount,
      line.costEntryId,
    ],
  );
}

/** Cost of the accepted quantity of a line over the receipts that are still posted. */
export async function postedCostOfLine(db: Db, poLineId: string): Promise<string> {
  const rows = await db.query<{ cost: string }>(
    `select coalesce(sum(gl.cost_amount), 0)::text as cost
       from prc_grn_lines gl join prc_grns g on g.id = gl.grn_id
      where gl.po_line_id = $1 and g.status = 'posted' and g.deleted_at is null`,
    [poLineId],
  );
  return (rows[0] as { cost: string }).cost;
}

/** Whether any receipt line, posted or cancelled, refers to the order line. */
export async function hasGrnLines(db: Db, poLineId: string): Promise<boolean> {
  const rows = await db.query<{ n: string }>(
    'select count(*) as n from prc_grn_lines where po_line_id = $1',
    [poLineId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Whether any posted receipt exists for the order (it can no longer be cancelled). */
export async function hasPostedReceipt(db: Db, poId: string): Promise<boolean> {
  const rows = await db.query<{ n: string }>(
    `select count(*) as n from prc_grns where po_id = $1 and status = 'posted' and deleted_at is null`,
    [poId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}
