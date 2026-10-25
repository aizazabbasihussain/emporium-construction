import type { Db } from '../types.js';
import { insertRow, likePattern, softDeleteRow, updateRow, type Values } from './crud.js';

export interface TemplateRow {
  id: string;
  code: string;
  name: string;
  work_type: string;
  parameters: { key: string; label: string; unit: string }[];
  active: boolean;
  version: number;
}

export interface TemplateLineRow {
  line_no: number;
  description: string;
  line_kind: string;
  item_id: string | null;
  cost_code_id: string;
  unit_code: string;
  qty_formula: string;
  default_rate: string | null;
  supplied_by: string;
}

export interface EstimateRow {
  id: string;
  number: string;
  revision: number;
  lead_id: string | null;
  party_id: string | null;
  template_id: string | null;
  title: string;
  work_type: string;
  sector: string;
  status: string;
  parent_estimate_id: string | null;
  parameters_values: Record<string, string>;
  overhead_percent: string;
  contingency_percent: string;
  target_margin_percent: string;
  proposed_price: string | null;
  locked_at: Date | null;
  version: number;
}

export interface EstimateLineRow {
  line_no: number;
  description: string;
  line_kind: string;
  item_id: string | null;
  cost_code_id: string;
  unit_code: string;
  quantity: string;
  rate: string;
  supplied_by: string;
  note: string | null;
}

// Templates ------------------------------------------------------------------------------------

const TEMPLATE_COLUMNS = 'id, code, name, work_type, parameters, active, version';

export const insertTemplate = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<TemplateRow>(db, 'est_templates', TEMPLATE_COLUMNS, values, by, at);

/** Undefined when the template is gone or its version moved on. */
export const updateTemplate = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) => updateRow<TemplateRow>(db, 'est_templates', TEMPLATE_COLUMNS, id, version, values, by, at);

export const softDeleteTemplate = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'est_templates', id, version, by, at);

export async function findTemplate(
  db: Db,
  id: string,
  lock = false,
): Promise<TemplateRow | undefined> {
  const rows = await db.query<TemplateRow>(
    `select ${TEMPLATE_COLUMNS} from est_templates
      where id = $1 and deleted_at is null ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0];
}

export async function templateCodeTaken(
  db: Db,
  code: string,
  exceptId: string | null,
): Promise<boolean> {
  const rows = await db.query(
    `select 1 from est_templates
      where lower(code) = lower($1) and deleted_at is null and ($2::uuid is null or id <> $2::uuid)`,
    [code, exceptId],
  );
  return rows.length > 0;
}

export interface TemplateSearch {
  q?: string | undefined;
  workType?: string | undefined;
  active?: boolean | undefined;
  limit: number;
  offset: number;
}

export async function searchTemplates(
  db: Db,
  search: TemplateSearch,
): Promise<{ rows: TemplateRow[]; total: number }> {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['deleted_at is null'];
  if (search.q !== undefined && search.q.trim() !== '') {
    const pattern = add(likePattern(search.q.trim()));
    where.push(`(code ilike ${pattern} or name ilike ${pattern})`);
  }
  if (search.workType !== undefined) where.push(`work_type = ${add(search.workType)}`);
  if (search.active !== undefined) where.push(`active = ${add(search.active)}`);
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from est_templates where ${filter}`,
    params,
  );
  const limit = add(search.limit);
  const offset = add(search.offset);
  const rows = await db.query<TemplateRow>(
    `select ${TEMPLATE_COLUMNS} from est_templates where ${filter}
      order by lower(code), id limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

const TEMPLATE_LINE_COLUMNS = `line_no, description, line_kind, item_id, cost_code_id, unit_code,
  qty_formula, default_rate::text as default_rate, supplied_by`;

export const listTemplateLines = (db: Db, templateId: string) =>
  db.query<TemplateLineRow>(
    `select ${TEMPLATE_LINE_COLUMNS} from est_template_lines where template_id = $1 order by line_no`,
    [templateId],
  );

/** Lines are replaced as a whole with the template they belong to. */
export async function replaceTemplateLines(
  db: Db,
  templateId: string,
  lines: (Values & { id: string })[],
): Promise<void> {
  await db.query('delete from est_template_lines where template_id = $1', [templateId]);
  for (const line of lines) {
    const values: Values = { ...line, template_id: templateId };
    const names = Object.keys(values);
    await db.query(
      `insert into est_template_lines (${names.join(', ')})
       values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      names.map((name) => values[name]),
    );
  }
}

// Estimates ------------------------------------------------------------------------------------

const ESTIMATE_COLUMNS = `id, number, revision, lead_id, party_id, template_id, title, work_type,
  sector, status, parent_estimate_id, parameters_values, overhead_percent::text as overhead_percent,
  contingency_percent::text as contingency_percent,
  target_margin_percent::text as target_margin_percent, proposed_price::text as proposed_price,
  locked_at, version`;

export const insertEstimate = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<EstimateRow>(db, 'est_estimates', ESTIMATE_COLUMNS, values, by, at);

/** Undefined when the estimate is gone or its version moved on. */
export const updateEstimate = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) => updateRow<EstimateRow>(db, 'est_estimates', ESTIMATE_COLUMNS, id, version, values, by, at);

export const softDeleteEstimate = (db: Db, id: string, version: number, by: string, at: Date) =>
  softDeleteRow(db, 'est_estimates', id, version, by, at);

export async function findEstimate(
  db: Db,
  id: string,
  lock = false,
): Promise<EstimateRow | undefined> {
  const rows = await db.query<EstimateRow>(
    `select ${ESTIMATE_COLUMNS} from est_estimates
      where id = $1 and deleted_at is null ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0];
}

/** The frozen totals of a locked estimate (BR-8). */
export async function findLockedTotals(db: Db, id: string): Promise<unknown> {
  const rows = await db.query<{ locked_totals: unknown }>(
    'select locked_totals from est_estimates where id = $1 and deleted_at is null',
    [id],
  );
  return rows[0]?.locked_totals;
}

export async function openRevisionExists(db: Db, parentId: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from est_estimates
      where parent_estimate_id = $1 and status = 'draft' and deleted_at is null`,
    [parentId],
  );
  return rows.length > 0;
}

export interface EstimateSearch {
  q?: string | undefined;
  status?: string | undefined;
  leadId?: string | undefined;
  partyId?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchEstimates(
  db: Db,
  search: EstimateSearch,
): Promise<{ rows: EstimateRow[]; total: number }> {
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
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from est_estimates where ${filter}`,
    params,
  );
  const limit = add(search.limit);
  const offset = add(search.offset);
  const rows = await db.query<EstimateRow>(
    `select ${ESTIMATE_COLUMNS} from est_estimates where ${filter}
      order by created_at desc, number desc, revision desc, id limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

const ESTIMATE_LINE_COLUMNS = `line_no, description, line_kind, item_id, cost_code_id, unit_code,
  quantity::text as quantity, rate::text as rate, supplied_by, note`;

export const listEstimateLines = (db: Db, estimateId: string) =>
  db.query<EstimateLineRow>(
    `select ${ESTIMATE_LINE_COLUMNS} from est_estimate_lines where estimate_id = $1 order by line_no`,
    [estimateId],
  );

/** Lines are replaced as a whole with the draft they belong to. */
export async function replaceEstimateLines(
  db: Db,
  estimateId: string,
  lines: (Values & { id: string })[],
): Promise<void> {
  await db.query('delete from est_estimate_lines where estimate_id = $1', [estimateId]);
  for (const line of lines) {
    const values: Values = { ...line, estimate_id: estimateId };
    const names = Object.keys(values);
    await db.query(
      `insert into est_estimate_lines (${names.join(', ')})
       values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      names.map((name) => values[name]),
    );
  }
}
