import type { Db } from '../types.js';
import { insertRow, likePattern, updateRow, type Values } from './crud.js';

export interface StageRow {
  code: string;
  name: string;
  sort_order: number;
  kind: string;
  active: boolean;
}

export interface ReferenceRow {
  code: string;
  name: string;
}

export interface LeadRow {
  id: string;
  number: string;
  party_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  work_type: string;
  sector: string;
  location_id: string | null;
  site_address: string | null;
  description: string | null;
  expected_value: string | null;
  source_code: string;
  stage_code: string;
  stage_kind: string;
  owner_user_id: string;
  loss_reason_code: string | null;
  won_at: Date | null;
  lost_at: Date | null;
  won_event_emitted: boolean;
  version: number;
}

export interface VisitRow {
  id: string;
  lead_id: string;
  visit_date: string;
  visited_by: string;
  notes: string | null;
  version: number;
}

export interface FollowUpRow {
  id: string;
  lead_id: string;
  lead_number: string;
  due_date: string;
  note: string | null;
  assigned_to: string;
  status: string;
  done_at: Date | null;
  version: number;
}

export interface HistoryRow {
  from_stage: string | null;
  to_stage: string;
  at: Date;
  by: string | null;
}

// Reference data -------------------------------------------------------------------------------

export const listStages = (db: Db) =>
  db.query<StageRow>(
    'select code, name, sort_order, kind, active from crm_stages order by sort_order',
  );

export async function findStage(db: Db, code: string): Promise<StageRow | undefined> {
  const rows = await db.query<StageRow>(
    'select code, name, sort_order, kind, active from crm_stages where code = $1',
    [code],
  );
  return rows[0];
}

export const listSources = (db: Db) =>
  db.query<ReferenceRow>('select code, name from crm_sources order by name');

export const listLossReasons = (db: Db) =>
  db.query<ReferenceRow>('select code, name from crm_loss_reasons order by name');

export async function sourceExists(db: Db, code: string): Promise<boolean> {
  return (await db.query('select 1 from crm_sources where code = $1', [code])).length > 0;
}

export async function lossReasonExists(db: Db, code: string): Promise<boolean> {
  return (await db.query('select 1 from crm_loss_reasons where code = $1', [code])).length > 0;
}

/** The first active stage of kind open (lowest sort order): where a new lead starts. */
export async function firstOpenStage(db: Db): Promise<StageRow | undefined> {
  const rows = await db.query<StageRow>(
    `select code, name, sort_order, kind, active from crm_stages
      where kind = 'open' and active order by sort_order limit 1`,
  );
  return rows[0];
}

// Leads ----------------------------------------------------------------------------------------

const LEAD_SELECT = `l.id, l.number, l.party_id, l.contact_name, l.contact_phone, l.work_type,
  l.sector, l.location_id, l.site_address, l.description, l.expected_value::text as expected_value,
  l.source_code, l.stage_code, s.kind as stage_kind, l.owner_user_id, l.loss_reason_code,
  l.won_at, l.lost_at, l.won_event_emitted, l.version`;

export async function findLead(db: Db, id: string, lock = false): Promise<LeadRow | undefined> {
  const rows = await db.query<LeadRow>(
    `select ${LEAD_SELECT} from crm_leads l join crm_stages s on s.code = l.stage_code
      where l.id = $1 and l.deleted_at is null ${lock ? 'for update of l' : ''}`,
    [id],
  );
  return rows[0];
}

export const insertLead = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<{ id: string }>(db, 'crm_leads', 'id', values, by, at);

/** Undefined when the lead is gone or its version moved on. */
export const updateLead = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) => updateRow<{ id: string }>(db, 'crm_leads', 'id', id, version, values, by, at);

export async function softDeleteLead(
  db: Db,
  id: string,
  version: number,
  by: string,
  at: Date,
): Promise<boolean> {
  const rows = await db.query(
    `update crm_leads
        set deleted_at = $1, updated_at = $1, updated_by = $2, version = version + 1
      where id = $3 and version = $4 and deleted_at is null
      returning id`,
    [at.toISOString(), by, id, version],
  );
  return rows.length === 1;
}

export interface LeadSearch {
  q?: string | undefined;
  stageCode?: string | undefined;
  sector?: string | undefined;
  ownerUserId?: string | undefined;
  /** Only leads with an open follow-up due before this date. */
  overdueBefore?: string | undefined;
  sort: 'number' | 'created' | 'value' | 'stage';
  direction: 'asc' | 'desc';
  limit: number;
  offset: number;
}

const SORT_COLUMNS: Record<LeadSearch['sort'], string> = {
  number: 'l.number',
  created: 'l.created_at',
  value: 'l.expected_value',
  stage: 's.sort_order',
};

export async function searchLeads(
  db: Db,
  search: LeadSearch,
): Promise<{ rows: LeadRow[]; total: number }> {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['l.deleted_at is null'];
  if (search.q !== undefined && search.q.trim() !== '') {
    const pattern = add(likePattern(search.q.trim()));
    where.push(
      `(l.number ilike ${pattern} or l.contact_name ilike ${pattern} or l.contact_phone ilike ${pattern}
        or l.description ilike ${pattern} or l.site_address ilike ${pattern})`,
    );
  }
  if (search.stageCode !== undefined) where.push(`l.stage_code = ${add(search.stageCode)}`);
  if (search.sector !== undefined) where.push(`l.sector = ${add(search.sector)}`);
  if (search.ownerUserId !== undefined) where.push(`l.owner_user_id = ${add(search.ownerUserId)}`);
  if (search.overdueBefore !== undefined) {
    where.push(
      `exists (select 1 from crm_follow_ups f where f.lead_id = l.id and f.status = 'open'
                 and f.deleted_at is null and f.due_date < ${add(search.overdueBefore)}::date)`,
    );
  }
  const direction = search.direction === 'desc' ? 'desc' : 'asc';
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from crm_leads l join crm_stages s on s.code = l.stage_code
      where ${filter}`,
    params,
  );
  const limit = add(search.limit);
  const offset = add(search.offset);
  const rows = await db.query<LeadRow>(
    `select ${LEAD_SELECT} from crm_leads l join crm_stages s on s.code = l.stage_code
      where ${filter}
      order by ${SORT_COLUMNS[search.sort]} ${direction} nulls last, l.id
      limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

export const leadsForPipeline = (db: Db) =>
  db.query<{ stage_code: string; expected_value: string | null }>(
    `select stage_code, expected_value::text as expected_value from crm_leads where deleted_at is null`,
  );

export async function markWonEventEmitted(db: Db, id: string): Promise<void> {
  await db.query('update crm_leads set won_event_emitted = true where id = $1', [id]);
}

// Stage history (append-only) ------------------------------------------------------------------

export async function insertHistory(
  db: Db,
  entry: { leadId: string; from: string | null; to: string; at: Date; by: string },
): Promise<void> {
  await db.query(
    `insert into crm_stage_history (lead_id, from_stage, to_stage, at, by)
     values ($1, $2, $3, $4, $5)`,
    [entry.leadId, entry.from, entry.to, entry.at.toISOString(), entry.by],
  );
}

export const listHistory = (db: Db, leadId: string) =>
  db.query<HistoryRow>(
    `select from_stage, to_stage, at, by from crm_stage_history where lead_id = $1 order by id`,
    [leadId],
  );

// Site visits ----------------------------------------------------------------------------------

const VISIT_COLUMNS = `id, lead_id, to_char(visit_date, 'YYYY-MM-DD') as visit_date, visited_by, notes, version`;

export const insertVisit = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<VisitRow>(db, 'crm_site_visits', VISIT_COLUMNS, values, by, at);

export const listVisits = (db: Db, leadId: string) =>
  db.query<VisitRow>(
    `select ${VISIT_COLUMNS} from crm_site_visits
      where lead_id = $1 and deleted_at is null order by visit_date desc, id`,
    [leadId],
  );

export async function visitExists(db: Db, id: string): Promise<boolean> {
  return (
    (await db.query('select 1 from crm_site_visits where id = $1 and deleted_at is null', [id]))
      .length > 0
  );
}

// Follow-ups -----------------------------------------------------------------------------------

const FOLLOW_UP_SELECT = `f.id, f.lead_id, l.number as lead_number,
  to_char(f.due_date, 'YYYY-MM-DD') as due_date, f.note, f.assigned_to, f.status, f.done_at, f.version`;

export const insertFollowUp = (db: Db, values: Values, by: string, at: Date) =>
  insertRow<{ id: string }>(db, 'crm_follow_ups', 'id', values, by, at);

export async function findFollowUp(
  db: Db,
  id: string,
  lock = false,
): Promise<FollowUpRow | undefined> {
  const rows = await db.query<FollowUpRow>(
    `select ${FOLLOW_UP_SELECT} from crm_follow_ups f join crm_leads l on l.id = f.lead_id
      where f.id = $1 and f.deleted_at is null ${lock ? 'for update of f' : ''}`,
    [id],
  );
  return rows[0];
}

export const updateFollowUp = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string,
  at: Date,
) => updateRow<{ id: string }>(db, 'crm_follow_ups', 'id', id, version, values, by, at);

export async function openFollowUpExists(
  db: Db,
  leadId: string,
  assignedTo: string,
  dueDate: string,
): Promise<boolean> {
  const rows = await db.query(
    `select 1 from crm_follow_ups
      where lead_id = $1 and assigned_to = $2 and due_date = $3::date and status = 'open'
        and deleted_at is null`,
    [leadId, assignedTo, dueDate],
  );
  return rows.length > 0;
}

export interface FollowUpSearch {
  leadId?: string | undefined;
  assignedTo?: string | undefined;
  status?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchFollowUps(
  db: Db,
  search: FollowUpSearch,
): Promise<{ rows: FollowUpRow[]; total: number }> {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ['f.deleted_at is null', 'l.deleted_at is null'];
  if (search.leadId !== undefined) where.push(`f.lead_id = ${add(search.leadId)}`);
  if (search.assignedTo !== undefined) where.push(`f.assigned_to = ${add(search.assignedTo)}`);
  if (search.status !== undefined) where.push(`f.status = ${add(search.status)}`);
  const filter = where.join(' and ');
  const total = await db.query<{ total: string }>(
    `select count(*) as total from crm_follow_ups f join crm_leads l on l.id = f.lead_id
      where ${filter}`,
    params,
  );
  const limit = add(search.limit);
  const offset = add(search.offset);
  const rows = await db.query<FollowUpRow>(
    `select ${FOLLOW_UP_SELECT} from crm_follow_ups f join crm_leads l on l.id = f.lead_id
      where ${filter} order by f.due_date, f.id limit ${limit} offset ${offset}`,
    params,
  );
  return { rows, total: Number(total[0]?.total ?? 0) };
}

/** P1-19 BR-6: the open follow-ups of live leads due before the date, oldest first. */
export async function listOverdueFollowUpRows(
  db: Db,
  before: string,
  assignedTo: string | null,
): Promise<FollowUpRow[]> {
  return db.query<FollowUpRow>(
    `select ${FOLLOW_UP_SELECT} from crm_follow_ups f join crm_leads l on l.id = f.lead_id
      where f.status = 'open' and f.deleted_at is null and l.deleted_at is null
        and f.due_date < $1::date and ($2::uuid is null or f.assigned_to = $2)
      order by f.due_date, f.id`,
    [before, assignedTo],
  );
}

/**
 * P1-19 BR-6: leads won and lost per month (Asia/Karachi) between two dates. A lead counts in the
 * month it was won or lost.
 */
export async function countClosedByMonth(
  db: Db,
  from: string,
  to: string,
): Promise<{ outcome: string; month: string; n: string }[]> {
  return db.query(
    `select 'won' as outcome, to_char(won_at at time zone 'Asia/Karachi', 'YYYY-MM') as month,
            count(*)::text as n
       from crm_leads
      where deleted_at is null and won_at is not null
        and (won_at at time zone 'Asia/Karachi')::date between $1::date and $2::date
      group by 2
     union all
     select 'lost', to_char(lost_at at time zone 'Asia/Karachi', 'YYYY-MM'), count(*)::text
       from crm_leads
      where deleted_at is null and lost_at is not null
        and (lost_at at time zone 'Asia/Karachi')::date between $1::date and $2::date
      group by 2`,
    [from, to],
  );
}

/** Open follow-ups of the given leads, to flag overdue ones in lists (BR-5). */
export async function openFollowUpsForLeads(
  db: Db,
  leadIds: readonly string[],
): Promise<{ lead_id: string; due_date: string; status: string }[]> {
  if (leadIds.length === 0) return [];
  return db.query(
    `select lead_id, to_char(due_date, 'YYYY-MM-DD') as due_date, status from crm_follow_ups
      where lead_id = any($1::uuid[]) and status = 'open' and deleted_at is null`,
    [leadIds],
  );
}

/** Open follow-ups of live leads, for the overdue count of the pipeline report. */
export async function openFollowUpDates(db: Db): Promise<{ due_date: string; status: string }[]> {
  return db.query(
    `select to_char(f.due_date, 'YYYY-MM-DD') as due_date, f.status
       from crm_follow_ups f join crm_leads l on l.id = f.lead_id
      where f.status = 'open' and f.deleted_at is null and l.deleted_at is null`,
  );
}

/** Cancels the open follow-ups of a lead that was closed (won or lost). Returns how many. */
export async function cancelOpenFollowUps(
  db: Db,
  leadId: string,
  by: string,
  at: Date,
): Promise<number> {
  const rows = await db.query(
    `update crm_follow_ups
        set status = 'cancelled', updated_at = $1, updated_by = $2, version = version + 1
      where lead_id = $3 and status = 'open' and deleted_at is null returning id`,
    [at.toISOString(), by, leadId],
  );
  return rows.length;
}
