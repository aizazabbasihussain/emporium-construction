import type { Db } from '../types.js';
import { findRow, insertRow, likePattern, softDeleteRow, updateRow, type Values } from './crud.js';

export interface QuotationRow {
  id: string;
  number: string;
  revision: number;
  parent_id: string | null;
  lead_id: string | null;
  estimate_id: string;
  party_id: string;
  title: string;
  sector: string;
  location_id: string | null;
  scope_text: string;
  inclusions: string;
  exclusions: string;
  terms: string;
  validity_days: number;
  price: string;
  status: string;
  issued_at: Date | null;
  accepted_at: Date | null;
  accepted_by_name: string | null;
  expires_on: string | null;
  version: number;
}

export interface StageRow {
  stage_no: number;
  name: string;
  basis: string;
  percent: string;
  amount: string;
  condition_text: string | null;
}

export interface HistoryRow {
  from_status: string | null;
  to_status: string;
  at: Date;
  changed_by: string | null;
  note: string | null;
}

const QUOTATION_COLUMNS = `id, number, revision, parent_id, lead_id, estimate_id, party_id, title,
  sector, location_id, scope_text, inclusions, exclusions, terms, validity_days,
  price::text as price, status, issued_at, accepted_at, accepted_by_name,
  to_char(expires_on, 'YYYY-MM-DD') as expires_on, version`;

export const insertQuotation = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<QuotationRow>(db, 'qte_quotations', QUOTATION_COLUMNS, values, by, at);

/** Undefined when the quotation is gone or its version moved on. */
export const updateQuotation = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<QuotationRow>(db, 'qte_quotations', QUOTATION_COLUMNS, id, version, values, by, at);

export const softDeleteQuotation = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'qte_quotations', id, version, by, at);

export const findQuotation = (db: Db, id: string, lock = false) =>
  findRow<QuotationRow>(db, 'qte_quotations', QUOTATION_COLUMNS, id, lock);

/** BR-4: a quotation has at most one open revision. */
export async function openRevisionExists(db: Db, parentId: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from qte_quotations
      where parent_id = $1 and status in ('draft', 'pending_approval', 'approved')
        and deleted_at is null`,
    [parentId],
  );
  return rows.length > 0;
}

export interface QuotationSearch {
  q?: string | undefined;
  status?: string | undefined;
  leadId?: string | undefined;
  partyId?: string | undefined;
  estimateId?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchQuotations(
  db: Db,
  search: QuotationSearch,
): Promise<{ rows: QuotationRow[]; total: number }> {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['deleted_at is null'];
  if (search.q !== undefined && search.q.trim() !== '') {
    const pattern = add(likePattern(search.q.trim()));
    where.push(`(number ilike ${pattern} or title ilike ${pattern})`);
  }
  if (search.status !== undefined) where.push(`status = ${add(search.status)}`);
  if (search.leadId !== undefined) where.push(`lead_id = ${add(search.leadId)}`);
  if (search.partyId !== undefined) where.push(`party_id = ${add(search.partyId)}`);
  if (search.estimateId !== undefined) where.push(`estimate_id = ${add(search.estimateId)}`);
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from qte_quotations where ${filter}`,
    params,
  );
  const limit = add(search.limit);
  const offset = add(search.offset);
  const rows = await db.query<QuotationRow>(
    `select ${QUOTATION_COLUMNS} from qte_quotations where ${filter}
      order by created_at desc, number desc, revision desc, id limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

/** BR-5: issued quotations whose expiry date is before `today`, oldest first. */
export const listIssuedExpiredBefore = (db: Db, today: string) =>
  db.query<QuotationRow>(
    `select ${QUOTATION_COLUMNS} from qte_quotations
      where status = 'issued' and expires_on < $1::date and deleted_at is null
      order by expires_on, id for update`,
    [today],
  );

const STAGE_COLUMNS = `stage_no, name, basis, percent::text as percent, amount::text as amount,
  condition_text`;

export const listStages = (db: Db, quotationId: string) =>
  db.query<StageRow>(
    `select ${STAGE_COLUMNS} from qte_stages where quotation_id = $1 order by stage_no`,
    [quotationId],
  );

/** The schedule is replaced as a whole with the draft it belongs to. */
export async function replaceStages(
  db: Db,
  quotationId: string,
  stages: (Values & { id: string })[],
): Promise<void> {
  await db.query('delete from qte_stages where quotation_id = $1', [quotationId]);
  for (const stage of stages) {
    const values: Values = { ...stage, quotation_id: quotationId };
    const names = Object.keys(values);
    await db.query(
      `insert into qte_stages (${names.join(', ')})
       values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      names.map((name) => values[name]),
    );
  }
}

export async function insertHistory(
  db: Db,
  entry: {
    id: string;
    quotationId: string;
    from: string | null;
    to: string;
    at: Date;
    by: string | null;
    note: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into qte_status_history (id, quotation_id, from_status, to_status, at, changed_by, note)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.id,
      entry.quotationId,
      entry.from,
      entry.to,
      entry.at.toISOString(),
      entry.by,
      entry.note,
    ],
  );
}

export const listHistory = (db: Db, quotationId: string) =>
  db.query<HistoryRow>(
    `select from_status, to_status, at, changed_by, note from qte_status_history
      where quotation_id = $1 order by at, id`,
    [quotationId],
  );
