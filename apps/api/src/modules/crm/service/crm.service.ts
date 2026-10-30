import { ValidationError } from '@emporium/domain';
import {
  assertContactPresent,
  assertLeadEditable,
  assertOnlyNotesChanged,
  assertVisitDate,
  conversionRate,
  isOverdue,
  normalizeExpectedValue,
  planStageMove,
  reminderInstant,
  sumExpectedValue,
  summarizePipeline,
  type StageKind,
} from '@emporium/domain/crm';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { assertReportPeriod, monthsBetween } from '@emporium/domain/reports';
import { normalizePhone } from '@emporium/domain/masterdata';
import {
  leadSectors,
  leadWorkTypes,
  type FollowUpStatus,
  type LeadSector,
  type LeadWorkType,
} from '@emporium/shared';
import type { MasterData } from '../../masterdata/index.js';
import type { Notifications } from '../../notifications/index.js';
import type { Platform } from '../../platform/index.js';
import {
  assertApplied,
  assertFollowUpFree,
  assertFound,
  assertKnown,
  assertUpdated,
} from '../policy/crm.policy.js';
import {
  cancelOpenFollowUps,
  countClosedByMonth,
  findFollowUp,
  findLead,
  findStage,
  firstOpenStage,
  insertFollowUp,
  insertHistory,
  insertLead,
  insertVisit,
  leadsForPipeline,
  listHistory,
  listOverdueFollowUpRows,
  listLossReasons,
  listSources,
  listStages,
  listVisits,
  lossReasonExists,
  markWonEventEmitted,
  openFollowUpDates,
  openFollowUpExists,
  openFollowUpsForLeads,
  searchFollowUps,
  searchLeads,
  softDeleteLead,
  sourceExists,
  updateFollowUp,
  updateLead,
  visitExists,
  type FollowUpRow,
  type FollowUpSearch,
  type LeadRow,
  type LeadSearch,
  type VisitRow,
} from '../repo/crm.repo.js';
import type {
  Actor,
  ConversionDto,
  Db,
  FollowUpDto,
  LeadDetailDto,
  LeadDto,
  PageResult,
  PipelineDto,
  ReferenceDto,
  StageDto,
  VisitDto,
} from '../types.js';
import { createRecorder, pageOf, requiredText, textOrNull } from './support.js';

export interface LeadInput {
  partyId?: string | null | undefined;
  contactName?: string | null | undefined;
  contactPhone?: string | null | undefined;
  workType: string;
  sector: string;
  locationId?: string | null | undefined;
  siteAddress?: string | null | undefined;
  description?: string | null | undefined;
  expectedValue?: string | null | undefined;
  sourceCode: string;
  ownerUserId?: string | undefined;
}

export interface StageMoveInput {
  stageCode: string;
  lossReasonCode?: string | null | undefined;
}

export type LeadListQuery = Omit<LeadSearch, 'overdueBefore'> & { overdue?: boolean | undefined };

export interface CrmService {
  reference(db: Db): Promise<{
    stages: StageDto[];
    sources: ReferenceDto[];
    lossReasons: ReferenceDto[];
  }>;
  createLead(input: LeadInput, actor: Actor, tx: Db): Promise<LeadDto>;
  updateLead(
    id: string,
    input: LeadInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<LeadDto>;
  removeLead(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  getLead(db: Db, id: string): Promise<LeadDto>;
  findLead(db: Db, id: string): Promise<LeadDto | undefined>;
  detail(db: Db, id: string): Promise<LeadDetailDto>;
  listLeads(db: Db, query: LeadListQuery): Promise<PageResult<LeadDto>>;
  /** BR-2, BR-3, BR-8. `canReopen` is whether the caller holds `crm.lead.reopen`. */
  moveStage(
    id: string,
    input: StageMoveInput,
    expectedVersion: number,
    canReopen: boolean,
    actor: Actor,
    tx: Db,
  ): Promise<LeadDto>;
  addVisit(
    leadId: string,
    input: { visitDate: string; notes?: string | null | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<VisitDto>;
  addFollowUp(
    leadId: string,
    input: {
      dueDate: string;
      note?: string | null | undefined;
      assignedTo?: string | undefined;
    },
    actor: Actor,
    tx: Db,
  ): Promise<FollowUpDto>;
  completeFollowUp(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<FollowUpDto>;
  listFollowUps(
    db: Db,
    query: Omit<FollowUpSearch, 'status'> & { status?: string | undefined },
  ): Promise<PageResult<FollowUpDto>>;
  pipeline(db: Db): Promise<PipelineDto>;
  /** P1-19 BR-6: conversion rate over a period and per month in it. */
  getConversion(db: Db, period: { from: string; to: string }): Promise<ConversionDto>;
  /** P1-19 BR-6: open follow-ups due before today (Asia/Karachi), oldest first. */
  listOverdueFollowUps(
    db: Db,
    filter?: { assignedTo?: string | undefined },
  ): Promise<FollowUpDto[]>;
  visitExists(db: Db, id: string): Promise<boolean>;
}

interface Prepared {
  partyId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  workType: LeadWorkType;
  sector: LeadSector;
  locationId: string | null;
  siteAddress: string | null;
  description: string | null;
  expectedValue: string | null;
  sourceCode: string;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`invalid_${field}`, `${field} is not valid`);
  }
  return value as T;
}

const normalizedAmount = (value: string | null | undefined): string | null => {
  const text = textOrNull(value);
  return text === null ? null : normalizeExpectedValue(text);
};

/** BR-1, BR-6: contact details are normalized; sector and work type are mandatory. */
function prepare(input: LeadInput): Prepared {
  const phone = textOrNull(input.contactPhone);
  const prepared: Prepared = {
    partyId: input.partyId ?? null,
    contactName: textOrNull(input.contactName),
    contactPhone: phone === null ? null : normalizePhone(phone),
    workType: oneOf(input.workType, leadWorkTypes, 'work_type'),
    sector: oneOf(input.sector, leadSectors, 'sector'),
    locationId: input.locationId ?? null,
    siteAddress: textOrNull(input.siteAddress),
    description: textOrNull(input.description),
    expectedValue: normalizedAmount(input.expectedValue),
    sourceCode: requiredText(input.sourceCode, 'source'),
  };
  assertContactPresent(prepared);
  return prepared;
}

const columnsOf = (prepared: Prepared) => ({
  party_id: prepared.partyId,
  contact_name: prepared.contactName,
  contact_phone: prepared.contactPhone,
  work_type: prepared.workType,
  sector: prepared.sector,
  location_id: prepared.locationId,
  site_address: prepared.siteAddress,
  description: prepared.description,
  expected_value: prepared.expectedValue,
  source_code: prepared.sourceCode,
});

/** The fields whose value differs from the stored lead (for the read-only rule of closed leads). */
function changedFields(prepared: Prepared, row: LeadRow): string[] {
  const before: Record<string, unknown> = {
    party_id: row.party_id,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    work_type: row.work_type,
    sector: row.sector,
    location_id: row.location_id,
    site_address: row.site_address,
    expected_value: row.expected_value,
    source_code: row.source_code,
    description: row.description,
  };
  const after = columnsOf(prepared) as Record<string, unknown>;
  return Object.keys(after).filter((field) => before[field] !== after[field]);
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

const toVisitDto = (row: VisitRow): VisitDto => ({
  id: row.id,
  leadId: row.lead_id,
  visitDate: row.visit_date,
  visitedBy: row.visited_by,
  notes: row.notes,
  version: row.version,
});

export function createCrmService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  masterData: Pick<MasterData, 'parties' | 'getParty' | 'listLocations'>;
  notifications: Pick<Notifications, 'scheduleReminder'>;
}): CrmService {
  const { platform, clock, newId, masterData, notifications } = deps;
  const record = createRecorder(platform);

  const toLeadDto = (row: LeadRow, overdue: boolean): LeadDto => ({
    id: row.id,
    number: row.number,
    partyId: row.party_id,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    workType: row.work_type as LeadWorkType,
    sector: row.sector as LeadSector,
    locationId: row.location_id,
    siteAddress: row.site_address,
    description: row.description,
    expectedValue: row.expected_value,
    sourceCode: row.source_code,
    stageCode: row.stage_code,
    stageKind: row.stage_kind as StageKind,
    ownerUserId: row.owner_user_id,
    lossReasonCode: row.loss_reason_code,
    wonAt: iso(row.won_at),
    lostAt: iso(row.lost_at),
    hasOverdueFollowUp: overdue,
    version: row.version,
  });

  const toFollowUpDto = (row: FollowUpRow): FollowUpDto => {
    const dueDate = row.due_date;
    return {
      id: row.id,
      leadId: row.lead_id,
      leadNumber: row.lead_number,
      dueDate,
      note: row.note,
      assignedTo: row.assigned_to,
      status: row.status as FollowUpStatus,
      doneAt: iso(row.done_at),
      overdue: isOverdue({ dueDate, status: row.status }, clock),
      version: row.version,
    };
  };

  /** BR-5: flags the leads that have an open follow-up past its due date. */
  async function leadDtos(db: Db, rows: LeadRow[]): Promise<LeadDto[]> {
    const open = await openFollowUpsForLeads(
      db,
      rows.map((row) => row.id),
    );
    const overdue = new Set(
      open
        .filter((f) => isOverdue({ dueDate: f.due_date, status: f.status }, clock))
        .map((f) => f.lead_id),
    );
    return rows.map((row) => toLeadDto(row, overdue.has(row.id)));
  }

  async function dtoOf(db: Db, id: string): Promise<LeadDto> {
    const row = assertFound(await findLead(db, id), 'lead');
    return (await leadDtos(db, [row]))[0] as LeadDto;
  }

  async function checkReferences(db: Db, prepared: Prepared): Promise<void> {
    assertKnown(
      await sourceExists(db, prepared.sourceCode),
      'unknown_source',
      'Unknown lead source',
    );
    if (prepared.partyId !== null) {
      assertKnown(
        (await masterData.getParty(db, prepared.partyId)) !== undefined,
        'unknown_party',
        'The linked client does not exist',
      );
    }
    if (prepared.locationId !== null) {
      const locations = await masterData.listLocations(db);
      assertKnown(
        locations.some((location) => location.id === prepared.locationId),
        'unknown_location',
        'Unknown location',
      );
    }
  }

  const summary = (row: LeadRow) => ({
    number: row.number,
    stage: row.stage_code,
    sector: row.sector,
    partyId: row.party_id,
  });

  async function lockedOpenLead(tx: Db, leadId: string): Promise<LeadRow> {
    const lead = assertFound(await findLead(tx, leadId, true), 'lead');
    assertLeadEditable(lead.stage_kind as StageKind);
    return lead;
  }

  return {
    async reference(db) {
      const [stages, sources, lossReasons] = await Promise.all([
        listStages(db),
        listSources(db),
        listLossReasons(db),
      ]);
      return {
        stages: stages.map((s) => ({
          code: s.code,
          name: s.name,
          sortOrder: s.sort_order,
          kind: s.kind as StageKind,
          active: s.active,
        })),
        sources,
        lossReasons,
      };
    },

    async createLead(input, actor, tx) {
      const prepared = prepare(input);
      await checkReferences(tx, prepared);
      const start = assertFound(await firstOpenStage(tx), 'stage');
      const id = newId();
      const number = await platform.numbering.next('lead', tx);
      const now = clock.now();
      await insertLead(
        tx,
        {
          id,
          number,
          ...columnsOf(prepared),
          stage_code: start.code,
          owner_user_id: input.ownerUserId ?? actor.userId,
        },
        actor.userId,
        now,
      );
      await insertHistory(tx, {
        leadId: id,
        from: null,
        to: start.code,
        at: now,
        by: actor.userId,
      });
      const row = assertFound(await findLead(tx, id), 'lead');
      await record(tx, actor, {
        action: 'crm.lead.create',
        entityType: 'crm_lead',
        entityId: id,
        after: summary(row),
        event: { type: 'crm.lead.changed', payload: { leadId: id, number, change: 'created' } },
      });
      return toLeadDto(row, false);
    },

    async updateLead(id, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findLead(tx, id, true), 'lead');
      const prepared = prepare(input);
      assertOnlyNotesChanged(existing.stage_kind as StageKind, changedFields(prepared, existing));
      await checkReferences(tx, prepared);
      assertUpdated(
        await updateLead(
          tx,
          id,
          expectedVersion,
          {
            ...columnsOf(prepared),
            owner_user_id: input.ownerUserId ?? existing.owner_user_id,
          },
          actor.userId,
          clock.now(),
        ),
      );
      const row = assertFound(await findLead(tx, id), 'lead');
      await record(tx, actor, {
        action: 'crm.lead.update',
        entityType: 'crm_lead',
        entityId: id,
        before: summary(existing),
        after: summary(row),
        event: {
          type: 'crm.lead.changed',
          payload: { leadId: id, number: row.number, change: 'updated' },
        },
      });
      return (await leadDtos(tx, [row]))[0] as LeadDto;
    },

    async removeLead(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findLead(tx, id, true), 'lead');
      assertLeadEditable(existing.stage_kind as StageKind);
      assertApplied(await softDeleteLead(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'crm.lead.delete',
        entityType: 'crm_lead',
        entityId: id,
        before: summary(existing),
        event: {
          type: 'crm.lead.changed',
          payload: { leadId: id, number: existing.number, change: 'deleted' },
        },
      });
    },

    getLead: (db, id) => dtoOf(db, id),

    async findLead(db, id) {
      const row = await findLead(db, id);
      return row === undefined ? undefined : (await leadDtos(db, [row]))[0];
    },

    async detail(db, id) {
      const lead = await dtoOf(db, id);
      const [visits, followUps, history] = await Promise.all([
        listVisits(db, id),
        searchFollowUps(db, { leadId: id, limit: 200, offset: 0 }),
        listHistory(db, id),
      ]);
      return {
        lead,
        visits: visits.map(toVisitDto),
        followUps: followUps.rows.map(toFollowUpDto),
        history: history.map((h) => ({
          fromStage: h.from_stage,
          toStage: h.to_stage,
          at: h.at.toISOString(),
          by: h.by,
        })),
      };
    },

    async listLeads(db, query) {
      const { overdue, ...rest } = query;
      const { rows, total } = await searchLeads(db, {
        ...rest,
        ...(overdue === true ? { overdueBefore: BusinessDate.today(clock).toString() } : {}),
      });
      return pageOf(await leadDtos(db, rows), total, query);
    },

    async moveStage(id, input, expectedVersion, canReopen, actor, tx) {
      const existing = assertFound(await findLead(tx, id, true), 'lead');
      const target = assertFound(await findStage(tx, input.stageCode), 'stage');
      assertKnown(target.active, 'stage_inactive', 'This stage is no longer in use');
      const lossReason = textOrNull(input.lossReasonCode);
      const plan = planStageMove({
        from: { code: existing.stage_code, kind: existing.stage_kind as StageKind },
        to: { code: target.code, kind: target.kind as StageKind },
        hasParty: existing.party_id !== null,
        lossReason,
        canReopen,
      });
      if (plan.closes === 'lost') {
        assertKnown(
          await lossReasonExists(tx, lossReason as string),
          'unknown_loss_reason',
          'Unknown loss reason',
        );
      }
      const now = clock.now();
      let partyId = existing.party_id;
      if (plan.needsParty) {
        // BR-2: the client is created through master data from the lead's contact.
        const party = await masterData.parties.create(
          {
            name: existing.contact_name as string,
            roles: ['client'],
            phone: existing.contact_phone,
          },
          actor,
          tx,
        );
        partyId = party.id;
      }
      assertUpdated(
        await updateLead(
          tx,
          id,
          expectedVersion,
          {
            stage_code: target.code,
            party_id: partyId,
            loss_reason_code: plan.closes === 'lost' ? lossReason : null,
            won_at: plan.closes === 'won' ? now.toISOString() : null,
            lost_at: plan.closes === 'lost' ? now.toISOString() : null,
          },
          actor.userId,
          now,
        ),
      );
      await insertHistory(tx, {
        leadId: id,
        from: existing.stage_code,
        to: target.code,
        at: now,
        by: actor.userId,
      });
      if (plan.closes !== null) await cancelOpenFollowUps(tx, id, actor.userId, now);
      const row = assertFound(await findLead(tx, id), 'lead');
      await record(tx, actor, {
        action: 'crm.lead.stage',
        entityType: 'crm_lead',
        entityId: id,
        before: summary(existing),
        after: { ...summary(row), lossReason },
        event: {
          type: 'crm.lead.stage_changed',
          payload: { leadId: id, number: row.number, from: existing.stage_code, to: target.code },
        },
      });
      if (plan.closes === 'won' && !existing.won_event_emitted) {
        // BR-8: once per lead, even if it is reopened and won again.
        await markWonEventEmitted(tx, id);
        await platform.events.publish(
          {
            type: 'crm.lead.won',
            payload: { leadId: id, partyId, number: row.number, sector: row.sector },
          },
          tx,
        );
      }
      return (await leadDtos(tx, [row]))[0] as LeadDto;
    },

    async addVisit(leadId, input, actor, tx) {
      const lead = await lockedOpenLead(tx, leadId);
      assertVisitDate(input.visitDate, clock);
      const row = await insertVisit(
        tx,
        {
          id: newId(),
          lead_id: leadId,
          visit_date: input.visitDate,
          visited_by: actor.userId,
          notes: textOrNull(input.notes),
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'crm.visit.create',
        entityType: 'crm_site_visit',
        entityId: row.id,
        after: { leadNumber: lead.number, visitDate: row.visit_date },
        event: {
          type: 'crm.visit.recorded',
          payload: { leadId, visitId: row.id, visitDate: row.visit_date },
        },
      });
      return toVisitDto(row);
    },

    async addFollowUp(leadId, input, actor, tx) {
      const lead = await lockedOpenLead(tx, leadId);
      const dueDate = BusinessDate.parse(input.dueDate).toString();
      const assignedTo = input.assignedTo ?? actor.userId;
      assertFollowUpFree(await openFollowUpExists(tx, leadId, assignedTo, dueDate));
      const now = clock.now();
      const { id } = await insertFollowUp(
        tx,
        {
          id: newId(),
          lead_id: leadId,
          due_date: dueDate,
          note: textOrNull(input.note),
          assigned_to: assignedTo,
          status: 'open',
        },
        actor.userId,
        now,
      );
      // BR-4: the assignee is reminded at 09:00 Asia/Karachi on the due date.
      await notifications.scheduleReminder(
        assignedTo,
        reminderInstant(dueDate),
        'crm.followup.due',
        { leadId, leadNumber: lead.number, followUpId: id, dueDate, note: textOrNull(input.note) },
        tx,
      );
      await record(tx, actor, {
        action: 'crm.followup.create',
        entityType: 'crm_follow_up',
        entityId: id,
        after: { leadNumber: lead.number, dueDate, assignedTo },
        event: {
          type: 'crm.followup.changed',
          payload: { leadId, followUpId: id, change: 'created' },
        },
      });
      return toFollowUpDto(assertFound(await findFollowUp(tx, id), 'follow_up'));
    },

    async completeFollowUp(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findFollowUp(tx, id, true), 'follow_up');
      if (existing.status !== 'open') {
        throw new ValidationError('follow_up_not_open', 'This follow-up is already closed');
      }
      const now = clock.now();
      assertUpdated(
        await updateFollowUp(
          tx,
          id,
          expectedVersion,
          { status: 'done', done_at: now.toISOString() },
          actor.userId,
          now,
        ),
      );
      await record(tx, actor, {
        action: 'crm.followup.done',
        entityType: 'crm_follow_up',
        entityId: id,
        before: { status: 'open' },
        after: { status: 'done' },
        event: {
          type: 'crm.followup.changed',
          payload: { leadId: existing.lead_id, followUpId: id, change: 'done' },
        },
      });
      return toFollowUpDto(assertFound(await findFollowUp(tx, id), 'follow_up'));
    },

    async listFollowUps(db, query) {
      const { rows, total } = await searchFollowUps(db, query);
      return pageOf(rows.map(toFollowUpDto), total, query);
    },

    async pipeline(db) {
      const [stages, leads, open] = await Promise.all([
        listStages(db),
        leadsForPipeline(db),
        openFollowUpDates(db),
      ]);
      const rows = summarizePipeline(
        stages.map((s) => s.code),
        leads.map((l) => ({ stageCode: l.stage_code, expectedValue: l.expected_value })),
      );
      return {
        stages: rows.map((row, i) => ({
          ...row,
          name: (stages[i] as { name: string }).name,
          kind: (stages[i] as { kind: StageKind }).kind,
        })),
        totalCount: leads.length,
        totalExpectedValue: sumExpectedValue(leads.map((l) => l.expected_value)),
        overdueFollowUps: open.filter((f) =>
          isOverdue({ dueDate: f.due_date, status: f.status }, clock),
        ).length,
      };
    },

    async getConversion(db, period) {
      assertReportPeriod(period.from, period.to);
      const from = BusinessDate.parse(period.from).toString();
      const to = BusinessDate.parse(period.to).toString();
      const counts = await countClosedByMonth(db, from, to);
      const countOf = (outcome: string, month: string) =>
        Number(counts.find((c) => c.outcome === outcome && c.month === month)?.n ?? 0);
      const months = monthsBetween(from, to).map((month) => {
        const won = countOf('won', month);
        const lost = countOf('lost', month);
        return { month, won, lost, rate: conversionRate(won, lost) };
      });
      const won = months.reduce((sum, m) => sum + m.won, 0);
      const lost = months.reduce((sum, m) => sum + m.lost, 0);
      return { from, to, won, lost, rate: conversionRate(won, lost), months };
    },

    async listOverdueFollowUps(db, filter = {}) {
      const rows = await listOverdueFollowUpRows(
        db,
        BusinessDate.today(clock).toString(),
        filter.assignedTo ?? null,
      );
      return rows.map(toFollowUpDto);
    },

    visitExists: (db, id) => visitExists(db, id),
  };
}
