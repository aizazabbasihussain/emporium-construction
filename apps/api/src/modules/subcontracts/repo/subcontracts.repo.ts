import type { Db } from '../types.js';
import { findRow, insertRow, softDeleteRow, updateRow, type Values } from './crud.js';

const DATE = (column: string) => `to_char(${column}, 'YYYY-MM-DD') as ${column}`;
const MONEY = (column: string) => `${column}::text as ${column}`;

/* ----------------------------------------------------------------- work orders */

export interface WorkOrderRow {
  id: string;
  number: string;
  project_id: string;
  party_id: string;
  title: string;
  scope_text: string;
  contract_amount: string;
  cost_code_id: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  retention_percent: string;
  commitment_entry_id: string | null;
  commitment_amount: string;
  closed_on: string | null;
  close_reason: string | null;
  cancelled_on: string | null;
  created_by: string | null;
  version: number;
}

const ORDER_COLUMNS = `id, number, project_id, party_id, title, scope_text, ${MONEY('contract_amount')},
  cost_code_id, ${DATE('start_date')}, ${DATE('end_date')}, status, ${MONEY('retention_percent')},
  commitment_entry_id, ${MONEY('commitment_amount')}, ${DATE('closed_on')}, close_reason,
  ${DATE('cancelled_on')}, created_by, version`;

export const insertWorkOrder = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<WorkOrderRow>(db, 'sub_work_orders', ORDER_COLUMNS, values, by, at);

export const findWorkOrder = (db: Db, id: string, lock = false) =>
  findRow<WorkOrderRow>(db, 'sub_work_orders', ORDER_COLUMNS, id, lock);

export const updateWorkOrder = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<WorkOrderRow>(db, 'sub_work_orders', ORDER_COLUMNS, id, version, values, by, at);

export const softDeleteWorkOrder = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'sub_work_orders', id, version, by, at);

export interface OrderQuery {
  projectId?: string | undefined;
  partyId?: string | undefined;
  status?: string | undefined;
  /** A scope-limited user (a supervisor) sees only these projects; undefined means all. */
  projectIds?: readonly string[] | undefined;
  limit: number;
  offset: number;
}

export async function searchWorkOrders(
  db: Db,
  q: OrderQuery,
): Promise<{ rows: WorkOrderRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (q.projectId !== undefined) {
    params.push(q.projectId);
    where.push(`project_id = $${params.length}`);
  }
  if (q.partyId !== undefined) {
    params.push(q.partyId);
    where.push(`party_id = $${params.length}`);
  }
  if (q.status !== undefined) {
    params.push(q.status);
    where.push(`status = $${params.length}`);
  }
  if (q.projectIds !== undefined) {
    params.push([...q.projectIds]);
    where.push(`project_id = any($${params.length}::uuid[])`);
  }
  const rows = await db.query<WorkOrderRow>(
    `select ${ORDER_COLUMNS} from sub_work_orders where ${where.join(' and ')}
      order by number desc limit ${q.limit} offset ${q.offset}`,
    params,
  );
  const count = await db.query<{ n: string }>(
    `select count(*) as n from sub_work_orders where ${where.join(' and ')}`,
    params,
  );
  return { rows, total: Number(count[0]?.n ?? 0) };
}

/** Every order of a subcontractor, for the statement (BR-9 scope is applied by the caller). */
export const listWorkOrdersOfParty = (db: Db, partyId: string) =>
  db.query<WorkOrderRow>(
    `select ${ORDER_COLUMNS} from sub_work_orders
      where party_id = $1 and deleted_at is null and status <> 'draft' and status <> 'cancelled'
      order by number`,
    [partyId],
  );

/* ------------------------------------------------------------------ variations */

export interface VariationRow {
  id: string;
  work_order_id: string;
  seq: number;
  amount: string;
  reason: string;
  status: string;
  decided_by: string | null;
  decided_on: string | null;
  decision_note: string | null;
  created_by: string | null;
  version: number;
}

const VARIATION_COLUMNS = `id, work_order_id, seq, ${MONEY('amount')}, reason, status, decided_by,
  ${DATE('decided_on')}, decision_note, created_by, version`;

export const insertVariation = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<VariationRow>(db, 'sub_work_order_variations', VARIATION_COLUMNS, values, by, at);

export const findVariation = (db: Db, id: string, lock = false) =>
  findRow<VariationRow>(db, 'sub_work_order_variations', VARIATION_COLUMNS, id, lock);

export const updateVariation = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) =>
  updateRow<VariationRow>(
    db,
    'sub_work_order_variations',
    VARIATION_COLUMNS,
    id,
    version,
    values,
    by,
    at,
  );

export const listVariations = (db: Db, workOrderId: string) =>
  db.query<VariationRow>(
    `select ${VARIATION_COLUMNS} from sub_work_order_variations
      where work_order_id = $1 and deleted_at is null order by seq`,
    [workOrderId],
  );

export const nextVariationSeq = (db: Db, workOrderId: string) =>
  db
    .query<{ seq: number }>(
      `select coalesce(max(seq), 0) + 1 as seq from sub_work_order_variations where work_order_id = $1`,
      [workOrderId],
    )
    .then((rows) => Number(rows[0]?.seq));

/* ---------------------------------------------------------------- certificates */

export interface CertificateRow {
  id: string;
  number: string;
  work_order_id: string;
  certificate_date: string;
  basis: string;
  cumulative_percent: string;
  cumulative_amount: string;
  this_certificate_amount: string;
  deductions: string;
  net_certified: string;
  status: string;
  certified_by: string | null;
  certified_on: string | null;
  notes: string | null;
  gross_entry_id: string | null;
  bill_id: string | null;
  created_by: string | null;
  version: number;
}

const CERTIFICATE_COLUMNS = `id, number, work_order_id, ${DATE('certificate_date')}, basis,
  ${MONEY('cumulative_percent')}, ${MONEY('cumulative_amount')},
  ${MONEY('this_certificate_amount')}, ${MONEY('deductions')}, ${MONEY('net_certified')}, status,
  certified_by, ${DATE('certified_on')}, notes, gross_entry_id, bill_id, created_by, version`;

export const insertCertificate = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<CertificateRow>(db, 'sub_certificates', CERTIFICATE_COLUMNS, values, by, at);

export const findCertificate = (db: Db, id: string, lock = false) =>
  findRow<CertificateRow>(db, 'sub_certificates', CERTIFICATE_COLUMNS, id, lock);

export const updateCertificate = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) =>
  updateRow<CertificateRow>(
    db,
    'sub_certificates',
    CERTIFICATE_COLUMNS,
    id,
    version,
    values,
    by,
    at,
  );

export const listCertificates = (db: Db, workOrderId: string) =>
  db.query<CertificateRow>(
    `select ${CERTIFICATE_COLUMNS} from sub_certificates
      where work_order_id = $1 and deleted_at is null order by number`,
    [workOrderId],
  );

/** BR-2: the cumulative gross of the latest certified (or billed) certificate; zero when none. */
export const certifiedCumulative = (db: Db, workOrderId: string) =>
  db
    .query<{ total: string }>(
      `select coalesce(max(cumulative_amount), 0)::numeric(18,2)::text as total
         from sub_certificates
        where work_order_id = $1 and status in ('certified', 'billed') and deleted_at is null`,
      [workOrderId],
    )
    .then((rows) => rows[0]?.total as string);

/** BR-6 and BR-7: how many certificates of an order are in each status. */
export const certificateCounts = (db: Db, workOrderId: string) =>
  db
    .query<{ status: string; n: string }>(
      `select status, count(*) as n from sub_certificates
        where work_order_id = $1 and deleted_at is null group by status`,
      [workOrderId],
    )
    .then((rows) => new Map(rows.map((row) => [row.status, Number(row.n)] as const)));

/* ---------------------------------------------------------------- back-charges */

export interface BackChargeRow {
  id: string;
  work_order_id: string;
  certificate_id: string | null;
  description: string;
  amount: string;
  recovers_cost: boolean;
  cost_code_id: string | null;
  entry_id: string | null;
  created_by: string | null;
  version: number;
}

const CHARGE_COLUMNS = `id, work_order_id, certificate_id, description, ${MONEY('amount')},
  recovers_cost, cost_code_id, entry_id, created_by, version`;

export const insertBackCharge = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<BackChargeRow>(db, 'sub_back_charges', CHARGE_COLUMNS, values, by, at);

export const findBackCharge = (db: Db, id: string, lock = false) =>
  findRow<BackChargeRow>(db, 'sub_back_charges', CHARGE_COLUMNS, id, lock);

export const updateBackCharge = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<BackChargeRow>(db, 'sub_back_charges', CHARGE_COLUMNS, id, version, values, by, at);

export const softDeleteBackCharge = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'sub_back_charges', id, version, by, at);

export const listBackChargesOfOrder = (db: Db, workOrderId: string) =>
  db.query<BackChargeRow>(
    `select ${CHARGE_COLUMNS} from sub_back_charges
      where work_order_id = $1 and deleted_at is null order by created_at, id`,
    [workOrderId],
  );

export const listBackChargesOfCertificate = (db: Db, certificateId: string) =>
  db.query<BackChargeRow>(
    `select ${CHARGE_COLUMNS} from sub_back_charges
      where certificate_id = $1 and deleted_at is null order by created_at, id`,
    [certificateId],
  );
