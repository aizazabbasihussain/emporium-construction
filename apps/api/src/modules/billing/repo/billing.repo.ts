import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

const DATE = (column: string) => `to_char(${column}, 'YYYY-MM-DD') as ${column}`;
const MONEY = (column: string) => `${column}::text as ${column}`;

/* ------------------------------------------------------------------ schedule */

export interface StageRow {
  id: string;
  project_id: string;
  stage_no: number;
  name: string;
  basis_percent: string | null;
  amount: string;
  source: string;
  source_id: string | null;
  status: string;
  version: number;
}

const STAGE_COLUMNS = `id, project_id, stage_no, name, basis_percent::text as basis_percent,
  ${MONEY('amount')}, source, source_id, status, version`;

export const insertStage = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<StageRow>(db, 'bil_billing_schedule', STAGE_COLUMNS, values, by, at);

export const listStages = (db: Db, projectId: string) =>
  db.query<StageRow>(
    `select ${STAGE_COLUMNS} from bil_billing_schedule
      where project_id = $1 and status <> 'cancelled' order by stage_no`,
    [projectId],
  );

export const findStages = (db: Db, projectId: string, ids: readonly string[]) =>
  db.query<StageRow>(
    `select ${STAGE_COLUMNS} from bil_billing_schedule
      where project_id = $1 and id = any($2::uuid[]) order by stage_no for update`,
    [projectId, ids],
  );

/** The planned stages are replaced as a whole by a manual edit (BR-1). */
export const deletePlannedStages = (db: Db, projectId: string) =>
  db.query("delete from bil_billing_schedule where project_id = $1 and status = 'planned'", [
    projectId,
  ]);

export const setStagesStatus = (
  db: Db,
  ids: readonly string[],
  status: string,
  by: string,
  at: Date,
) =>
  db.query(
    `update bil_billing_schedule
        set status = $1, updated_at = $2, updated_by = $3, version = version + 1
      where id = any($4::uuid[])`,
    [status, at.toISOString(), by, ids],
  );

/** BR-2: a stage belongs to at most one invoice that is not cancelled. */
export const stagesOnLiveInvoices = (
  db: Db,
  scheduleIds: readonly string[],
  exceptInvoiceId: string | null,
) =>
  db
    .query<{ schedule_id: string }>(
      `select l.schedule_id from bil_invoice_lines l join bil_invoices i on i.id = l.invoice_id
        where l.schedule_id = any($1::uuid[]) and i.status <> 'cancelled' and i.deleted_at is null
          and ($2::uuid is null or i.id <> $2::uuid)`,
      [scheduleIds, exceptInvoiceId],
    )
    .then((rows) => rows.map((row) => row.schedule_id));

export interface EditRow {
  id: string;
  project_id: string;
  status: string;
  previous: StageSnapshot[];
}

export interface StageSnapshot {
  id: string;
  stageNo: number;
  name: string;
  basisPercent: string | null;
  amount: string;
  source: string;
  sourceId: string | null;
}

export const insertEdit = (
  db: Db,
  edit: { id: string; projectId: string; previous: StageSnapshot[]; by: string; at: Date },
) =>
  db.query(
    `insert into bil_schedule_edits (id, project_id, previous, created_at, created_by)
     values ($1, $2, $3, $4, $5)`,
    [edit.id, edit.projectId, JSON.stringify(edit.previous), edit.at.toISOString(), edit.by],
  );

export const findEdit = (db: Db, id: string) =>
  db
    .query<EditRow>(
      'select id, project_id, status, previous from bil_schedule_edits where id = $1 for update',
      [id],
    )
    .then((rows) => rows[0]);

export const pendingEditId = (db: Db, projectId: string) =>
  db
    .query<{ id: string }>(
      `select id from bil_schedule_edits
        where project_id = $1 and status = 'pending_approval' order by created_at limit 1`,
      [projectId],
    )
    .then((rows) => rows[0]?.id ?? null);

export const decideEdit = (db: Db, id: string, status: string, at: Date) =>
  db.query('update bil_schedule_edits set status = $1, decided_at = $2 where id = $3', [
    status,
    at.toISOString(),
    id,
  ]);

/* ------------------------------------------------------------------ invoices */

export interface InvoiceRow {
  id: string;
  number: string | null;
  series_code: string | null;
  authority_code: string | null;
  source_type: string;
  project_id: string;
  party_id: string;
  invoice_date: string;
  due_date: string;
  status: string;
  base_amount: string;
  advance_recovery: string;
  taxable_base: string;
  tax_total: string;
  gross_total: string;
  withholding_expected: string;
  tax_snapshot: unknown;
  registration_number: string | null;
  tax_on_advance_at_receipt: boolean;
  payment_days: number | null;
  notes: string | null;
  issued_at: Date | null;
  version: number;
}

const INVOICE_COLUMNS = `id, number, series_code, authority_code, source_type, project_id, party_id,
  ${DATE('invoice_date')}, ${DATE('due_date')}, status, ${MONEY('base_amount')},
  ${MONEY('advance_recovery')}, ${MONEY('taxable_base')}, ${MONEY('tax_total')},
  ${MONEY('gross_total')}, ${MONEY('withholding_expected')}, tax_snapshot, registration_number,
  tax_on_advance_at_receipt, payment_days, notes, issued_at, version`;

export const insertInvoice = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<InvoiceRow>(db, 'bil_invoices', INVOICE_COLUMNS, values, by, at);

/** Undefined when the invoice is gone or its version moved on. */
export const updateInvoice = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<InvoiceRow>(db, 'bil_invoices', INVOICE_COLUMNS, id, version, values, by, at);

export const findInvoice = (db: Db, id: string, lock = false) =>
  findRow<InvoiceRow>(db, 'bil_invoices', INVOICE_COLUMNS, id, lock);

export interface InvoiceSearch {
  projectId?: string | undefined;
  status?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchInvoices(
  db: Db,
  search: InvoiceSearch,
): Promise<{ rows: InvoiceRow[]; total: number }> {
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (search.projectId !== undefined) {
    params.push(search.projectId);
    where.push(`project_id = $${params.length}`);
  }
  if (search.status !== undefined) {
    params.push(search.status);
    where.push(`status = $${params.length}`);
  }
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from bil_invoices where ${filter}`,
    params,
  );
  const rows = await db.query<InvoiceRow>(
    `select ${INVOICE_COLUMNS} from bil_invoices where ${filter}
      order by invoice_date desc, created_at desc, id limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, search.limit, search.offset],
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

export interface LineRow {
  line_no: number;
  schedule_id: string | null;
  description: string;
  amount: string;
  supply_kind: string;
  nature: string | null;
}

export const listLines = (db: Db, invoiceId: string) =>
  db.query<LineRow>(
    `select line_no, schedule_id, description, ${MONEY('amount')}, supply_kind, nature
       from bil_invoice_lines where invoice_id = $1 order by line_no`,
    [invoiceId],
  );

export interface NewLine {
  id: string;
  lineNo: number;
  scheduleId: string | null;
  description: string;
  amount: string;
  supplyKind: string;
  nature: string | null;
}

/** The lines are replaced as a whole with the draft they belong to. */
export async function replaceLines(
  db: Db,
  invoiceId: string,
  lines: readonly NewLine[],
): Promise<void> {
  await db.query('delete from bil_invoice_lines where invoice_id = $1', [invoiceId]);
  for (const line of lines) {
    await db.query(
      `insert into bil_invoice_lines
         (id, invoice_id, line_no, schedule_id, description, amount, supply_kind, nature)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        line.id,
        invoiceId,
        line.lineNo,
        line.scheduleId,
        line.description,
        line.amount,
        line.supplyKind,
        line.nature,
      ],
    );
  }
}

/**
 * BR-7: invoices that count against the contract (everything not draft and not cancelled, except
 * the one being checked) at their base less advance recovery, minus the issued credit notes.
 */
export async function netBilled(
  db: Db,
  projectId: string,
  statuses: readonly string[],
  exceptInvoiceId: string | null,
): Promise<string> {
  const rows = await db.query<{ net: string }>(
    `select (
        coalesce((select sum(base_amount - advance_recovery) from bil_invoices
                   where project_id = $1 and status = any($2::text[]) and deleted_at is null
                     and ($3::uuid is null or id <> $3::uuid)), 0)
      - coalesce((select sum(c.base_amount - c.advance_restored)
                    from bil_credit_notes c join bil_invoices i on i.id = c.invoice_id
                   where i.project_id = $1 and c.status = 'issued' and c.deleted_at is null
                     and i.status = any($2::text[]) and ($3::uuid is null or i.id <> $3::uuid)), 0)
      )::numeric(18,2)::text as net`,
    [projectId, statuses, exceptInvoiceId],
  );
  return (rows[0] as { net: string }).net;
}

export const countInvoices = (db: Db, projectId: string) =>
  db
    .query<{ n: string }>(
      "select count(*) as n from bil_invoices where project_id = $1 and deleted_at is null and status <> 'cancelled'",
      [projectId],
    )
    .then((rows) => Number(rows[0]?.n ?? 0));

/* ------------------------------------------------------------------ advances */

export interface AdvanceRow {
  id: string;
  project_id: string;
  party_id: string;
  invoice_id: string | null;
  amount: string;
  received_on: string | null;
  applied: string;
  status: string;
  version: number;
}

const ADVANCE_COLUMNS = `id, project_id, party_id, invoice_id, ${MONEY('amount')},
  ${DATE('received_on')}, ${MONEY('applied')}, status, version`;

export const insertAdvance = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<AdvanceRow>(db, 'bil_advances', ADVANCE_COLUMNS, values, by, at);

export const updateAdvance = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<AdvanceRow>(db, 'bil_advances', ADVANCE_COLUMNS, id, version, values, by, at);

export const findAdvance = (db: Db, id: string, lock = false) =>
  findRow<AdvanceRow>(db, 'bil_advances', ADVANCE_COLUMNS, id, lock);

export const findAdvanceByInvoice = (db: Db, invoiceId: string) =>
  db
    .query<AdvanceRow>(
      `select ${ADVANCE_COLUMNS} from bil_advances
        where invoice_id = $1 and deleted_at is null for update`,
      [invoiceId],
    )
    .then((rows) => rows[0]);

export const listAdvances = (db: Db, projectId: string) =>
  db.query<AdvanceRow>(
    `select ${ADVANCE_COLUMNS} from bil_advances
      where project_id = $1 and deleted_at is null order by created_at, id`,
    [projectId],
  );

/** BR-3: advance received and not yet applied. */
export const unappliedAdvance = (db: Db, projectId: string) =>
  db
    .query<{ total: string }>(
      `select coalesce(sum(amount - applied), 0)::numeric(18,2)::text as total
         from bil_advances where project_id = $1 and status = 'received' and deleted_at is null`,
      [projectId],
    )
    .then((rows) => (rows[0] as { total: string }).total);

/** Oldest receipt first when an invoice applies the advance; newest first when a credit gives it back. */
export const lockedAdvances = (db: Db, projectId: string, order: 'asc' | 'desc') =>
  db.query<AdvanceRow>(
    `select ${ADVANCE_COLUMNS} from bil_advances
      where project_id = $1 and deleted_at is null and status in ('received', 'fully_applied')
      order by received_on ${order === 'asc' ? 'asc' : 'desc'}, created_at ${order === 'asc' ? 'asc' : 'desc'},
               id ${order === 'asc' ? 'asc' : 'desc'}
      for update`,
    [projectId],
  );

/**
 * The stored tax snapshots for the tax report (P2-01 BR-8): numbered invoices and issued credit
 * notes of one authority in a date range. An invoice cancelled by a credit note stays in, and the
 * credit note takes it off.
 */
export const taxReportRows = (db: Db, query: { authorityCode: string; from: string; to: string }) =>
  db.query<{ documentId: string; kind: string; date: string; base: string; tax: string }>(
    `select id::text as "documentId", 'invoice' as kind,
            to_char(invoice_date, 'YYYY-MM-DD') as date, taxable_base::text as base,
            tax_total::text as tax
       from bil_invoices
      where number is not null and authority_code = $1 and invoice_date between $2 and $3
        and deleted_at is null
     union all
     select c.id::text, 'credit_note', to_char(c.issued_on, 'YYYY-MM-DD'),
            coalesce(c.tax_snapshot ->> 'taxableBase', '0'), c.tax_total::text
       from bil_credit_notes c join bil_invoices i on i.id = c.invoice_id
      where c.status = 'issued' and i.authority_code = $1 and c.issued_on between $2 and $3
        and c.deleted_at is null
      order by date, "documentId"`,
    [query.authorityCode, query.from, query.to],
  );

/* --------------------------------------------------------------- credit notes */

export interface CreditNoteRow {
  id: string;
  number: string | null;
  invoice_id: string;
  reason: string;
  base_amount: string;
  advance_restored: string;
  tax_total: string;
  gross_total: string;
  issued_on: string | null;
  tax_snapshot: unknown;
  status: string;
  version: number;
}

const CREDIT_COLUMNS = `id, number, invoice_id, reason, ${MONEY('base_amount')},
  ${MONEY('advance_restored')}, ${MONEY('tax_total')}, ${MONEY('gross_total')},
  ${DATE('issued_on')}, tax_snapshot, status, version`;

export const insertCreditNote = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<CreditNoteRow>(db, 'bil_credit_notes', CREDIT_COLUMNS, values, by, at);

export const updateCreditNote = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<CreditNoteRow>(db, 'bil_credit_notes', CREDIT_COLUMNS, id, version, values, by, at);

export const findCreditNote = (db: Db, id: string, lock = false) =>
  findRow<CreditNoteRow>(db, 'bil_credit_notes', CREDIT_COLUMNS, id, lock);

export const listCreditNotes = (db: Db, invoiceId: string) =>
  db.query<CreditNoteRow>(
    `select ${CREDIT_COLUMNS} from bil_credit_notes
      where invoice_id = $1 and deleted_at is null order by created_at, id`,
    [invoiceId],
  );

export interface PriorTotals {
  base: string;
  restored: string;
  tax: string;
}

/**
 * Credit notes already taken against an invoice. At creation drafts count too, so two drafts cannot
 * together exceed the invoice; at issue only issued ones count.
 */
export const priorCredits = (
  db: Db,
  invoiceId: string,
  options: { issuedOnly: boolean; exceptId: string | null },
) =>
  db
    .query<PriorTotals>(
      `select coalesce(sum(base_amount), 0)::numeric(18,2)::text as base,
              coalesce(sum(advance_restored), 0)::numeric(18,2)::text as restored,
              coalesce(sum(tax_total), 0)::numeric(18,2)::text as tax
         from bil_credit_notes
        where invoice_id = $1 and deleted_at is null
          and ($2::boolean = false or status = 'issued')
          and ($3::uuid is null or id <> $3::uuid)`,
      [invoiceId, options.issuedOnly, options.exceptId],
    )
    .then((rows) => rows[0] as PriorTotals);

/** Issued credit gross of an invoice, for receivables. */
export const issuedCreditBase = (db: Db, invoiceId: string) =>
  priorCredits(db, invoiceId, { issuedOnly: true, exceptId: null }).then((totals) => totals.base);
