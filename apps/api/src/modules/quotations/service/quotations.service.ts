import {
  assertAcceptanceProof,
  assertEditable,
  assertRevisable,
  assertTransition,
  assertValidityDays,
  buildPrintModel,
  deriveStages,
  displayNumber,
  expiryDate,
  isExpired,
  marginPanel,
  normalizePrice,
  requireText,
  type QuotationPrintModel,
  type QuotationStatus,
  type Stage,
  type StageInput,
} from '@emporium/domain/quotations';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import {
  quotationDocType,
  quotationEntityType,
  quotationSettingKeys,
  type EstimateSector,
} from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { Crm } from '../../crm/index.js';
import type { Estimation } from '../../estimation/index.js';
import type { Files } from '../../files/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import {
  assertApplied,
  assertCompanyProfile,
  assertEstimateLocked,
  assertFound,
  assertKnown,
  assertNoOpenRevision,
  assertNotPastExpiry,
  assertUpdated,
} from '../policy/quotations.policy.js';
import {
  findQuotation,
  insertHistory,
  insertQuotation,
  listHistory,
  listIssuedExpiredBefore,
  listStages,
  openRevisionExists,
  replaceStages,
  searchQuotations,
  softDeleteQuotation,
  updateQuotation,
  type QuotationRow,
  type QuotationSearch,
  type StageRow,
} from '../repo/quotations.repo.js';
import type {
  Actor,
  Db,
  MarginPanelDto,
  PageResult,
  QuotationDto,
  QuotationHeaderDto,
  StageDto,
} from '../types.js';
import { createRecorder, pageOf, requiredText, textOrNull } from './support.js';

export interface QuotationInput {
  estimateId?: string | undefined;
  title?: string | undefined;
  partyId?: string | null | undefined;
  leadId?: string | null | undefined;
  locationId?: string | null | undefined;
  scopeText?: string | undefined;
  inclusions?: string | undefined;
  exclusions?: string | undefined;
  terms?: string | undefined;
  validityDays?: number | undefined;
  /** Defaults to the proposed price of the estimate (BR-1). */
  price?: string | undefined;
  stages: StageInput[];
}

export interface CreateQuotationInput extends QuotationInput {
  estimateId: string;
}

export interface AcceptInput {
  /** BR-6: who accepted on the client's side. */
  acceptedByName: string;
  note?: string | null | undefined;
}

export interface ApprovalOutcomePayload {
  docType: string;
  docId: string;
  requesterId: string;
}

export interface QuotationService {
  list(db: Db, query: QuotationSearch): Promise<PageResult<QuotationHeaderDto>>;
  /** `includeMargin` is whether the caller holds `quotations.margin.read` (spec section 5). */
  get(db: Db, id: string, includeMargin: boolean): Promise<QuotationDto>;
  /** Module interface `getQuotation(id)` (spec section 2). */
  summary(db: Db, id: string): Promise<QuotationHeaderDto & { stages: StageDto[] }>;
  create(
    input: CreateQuotationInput,
    actor: Actor,
    tx: Db,
    includeMargin: boolean,
  ): Promise<QuotationDto>;
  update(
    id: string,
    input: QuotationInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
    includeMargin: boolean,
  ): Promise<QuotationDto>;
  remove(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  /** BR-2 */
  submit(
    id: string,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
    includeMargin: boolean,
  ): Promise<QuotationDto>;
  /** BR-4, BR-5 */
  issue(
    id: string,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
    includeMargin: boolean,
  ): Promise<QuotationDto>;
  /** BR-6 */
  accept(
    id: string,
    input: AcceptInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
    includeMargin: boolean,
  ): Promise<QuotationDto>;
  /** BR-10 */
  reject(
    id: string,
    reason: string,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
    includeMargin: boolean,
  ): Promise<QuotationDto>;
  /** BR-4: a new draft copy of an issued, rejected or expired quotation. */
  revise(id: string, actor: Actor, tx: Db, includeMargin: boolean): Promise<QuotationDto>;
  /** BR-8, BR-9 */
  printModel(db: Db, id: string): Promise<QuotationPrintModel>;
  /** BR-5: marks issued quotations past their expiry date as expired; returns how many. */
  expireDue(tx: Db): Promise<number>;
  /** The approval engine decided: approved moves on, anything else returns the draft. */
  onApprovalOutcome(
    outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
    payload: ApprovalOutcomePayload,
    tx: Db,
  ): Promise<void>;
  /** Whether a quotation exists, for the file access rule. */
  exists(db: Db, id: string): Promise<boolean>;
}

const stageDto = (row: StageRow): StageDto => ({
  stageNo: row.stage_no,
  name: row.name,
  basis: row.basis as StageDto['basis'],
  percent: row.percent,
  amount: row.amount,
  conditionText: row.condition_text,
});

const headerOf = (row: QuotationRow): QuotationHeaderDto => ({
  id: row.id,
  number: row.number,
  revision: row.revision,
  displayNumber: displayNumber(row.number, row.revision),
  parentId: row.parent_id,
  leadId: row.lead_id,
  estimateId: row.estimate_id,
  partyId: row.party_id,
  title: row.title,
  sector: row.sector as EstimateSector,
  locationId: row.location_id,
  validityDays: row.validity_days,
  price: row.price,
  status: row.status as QuotationStatus,
  issuedAt: row.issued_at === null ? null : row.issued_at.toISOString(),
  acceptedAt: row.accepted_at === null ? null : row.accepted_at.toISOString(),
  acceptedByName: row.accepted_by_name,
  expiresOn: row.expires_on,
  version: row.version,
});

const DEFAULT_VALIDITY_DAYS = 30;

export function createQuotationService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  estimation: Pick<Estimation, 'getEstimate'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
  crm: Pick<Crm, 'getLead'>;
  masterData: Pick<MasterData, 'getParty' | 'listLocations' | 'company'>;
  files: Pick<Files, 'list'>;
}): QuotationService {
  const { platform, clock, newId, estimation, approvals, crm, masterData, files } = deps;
  const record = createRecorder(platform);

  const changed = (row: QuotationRow, change: string) => ({
    type: 'quotations.quotation.changed',
    payload: {
      quotationId: row.id,
      number: row.number,
      revision: row.revision,
      status: row.status,
      change,
    },
  });

  const summaryOf = (row: QuotationRow, stageCount: number) => ({
    number: row.number,
    revision: row.revision,
    status: row.status,
    price: row.price,
    stages: stageCount,
  });

  const stagesOf = async (db: Db, id: string): Promise<Stage[]> =>
    (await listStages(db, id)).map((row) => ({
      stageNo: row.stage_no,
      name: row.name,
      basis: row.basis as Stage['basis'],
      percent: row.percent,
      amount: row.amount,
      conditionText: row.condition_text,
    }));

  /** BR-2: the margin of the price against the total cost of the locked estimate. */
  async function marginOf(db: Db, row: QuotationRow): Promise<MarginPanelDto> {
    const { totals } = await estimation.getEstimate(db, row.estimate_id);
    const floor = String(
      (await platform.settings.get(db, quotationSettingKeys.marginFloorPercent)).value,
    );
    return marginPanel(row.price, totals.totalCost, floor);
  }

  async function dtoOf(db: Db, row: QuotationRow, includeMargin: boolean): Promise<QuotationDto> {
    const state = await approvals.getApprovalState(db, quotationDocType, row.id);
    return {
      ...headerOf(row),
      scopeText: row.scope_text,
      inclusions: row.inclusions,
      exclusions: row.exclusions,
      terms: row.terms,
      stages: (await listStages(db, row.id)).map(stageDto),
      history: (await listHistory(db, row.id)).map((h) => ({
        fromStatus: h.from_status as QuotationStatus | null,
        toStatus: h.to_status as QuotationStatus,
        at: h.at.toISOString(),
        changedBy: h.changed_by,
        note: h.note,
      })),
      margin: includeMargin ? await marginOf(db, row) : null,
      approval:
        state.status === 'none'
          ? { status: 'none', requestId: null, currentRole: null }
          : { status: state.status, requestId: state.id, currentRole: state.currentRole },
    };
  }

  /** Checks the references and derives the stored fields and the stage schedule (BR-1, BR-3). */
  async function prepare(db: Db, input: QuotationInput, current: QuotationRow | undefined) {
    const estimateId = input.estimateId ?? (current as QuotationRow).estimate_id;
    const { estimate, totals } = await estimation.getEstimate(db, estimateId);
    assertEstimateLocked(estimate.status);
    const leadId =
      input.leadId === undefined ? (current?.lead_id ?? estimate.leadId) : input.leadId;
    const lead = leadId === null ? null : await crm.getLead(db, leadId);
    const partyId = input.partyId ?? current?.party_id ?? estimate.partyId ?? lead?.partyId ?? null;
    assertKnown(partyId !== null, 'party_required', 'Choose the client');
    assertKnown(
      (await masterData.getParty(db, partyId as string)) !== undefined,
      'unknown_party',
      'The client does not exist',
    );
    const locationId =
      input.locationId === undefined
        ? (current?.location_id ?? lead?.locationId ?? null)
        : input.locationId;
    if (locationId !== null) {
      assertKnown(
        (await masterData.listLocations(db)).some((location) => location.id === locationId),
        'unknown_location',
        'The location does not exist',
      );
    }
    const validityDays = input.validityDays ?? current?.validity_days ?? DEFAULT_VALIDITY_DAYS;
    assertValidityDays(validityDays);
    const price = normalizePrice(input.price ?? (current ? current.price : totals.proposedPrice));
    const stages = deriveStages(price, input.stages);
    return {
      values: {
        estimate_id: estimateId,
        lead_id: leadId,
        party_id: partyId,
        location_id: locationId,
        sector: estimate.sector,
        title: requiredText(input.title ?? current?.title ?? estimate.title, 'title'),
        scope_text: input.scopeText?.trim() ?? current?.scope_text ?? '',
        inclusions: input.inclusions?.trim() ?? current?.inclusions ?? '',
        exclusions: input.exclusions?.trim() ?? current?.exclusions ?? '',
        terms: input.terms?.trim() ?? current?.terms ?? '',
        validity_days: validityDays,
        price,
      },
      stages,
    };
  }

  const stageRows = (stages: readonly Stage[]) =>
    stages.map((stage) => ({
      id: newId(),
      stage_no: stage.stageNo,
      name: stage.name,
      basis: stage.basis,
      percent: stage.percent,
      amount: stage.amount,
      condition_text: stage.conditionText,
    }));

  /** One status change: the transition table, the row update, the history line (BR-4). */
  async function moveTo(
    tx: Db,
    row: QuotationRow,
    to: QuotationStatus,
    values: Record<string, unknown>,
    by: string | null,
    note: string | null,
  ): Promise<QuotationRow> {
    assertTransition(row.status as QuotationStatus, to);
    const at = clock.now();
    const next = assertUpdated(
      await updateQuotation(tx, row.id, row.version, { status: to, ...values }, by, at),
    );
    await insertHistory(tx, {
      id: newId(),
      quotationId: row.id,
      from: row.status,
      to,
      at,
      by,
      note,
    });
    return next;
  }

  async function withLock(tx: Db, id: string, expectedVersion?: number): Promise<QuotationRow> {
    const row = assertFound(await findQuotation(tx, id, true), 'quotation');
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      assertUpdated(undefined);
    }
    return row;
  }

  return {
    async list(db, query) {
      const { rows, total } = await searchQuotations(db, query);
      return pageOf(rows.map(headerOf), total, query);
    },

    async get(db, id, includeMargin) {
      return dtoOf(db, assertFound(await findQuotation(db, id), 'quotation'), includeMargin);
    },

    async summary(db, id) {
      const row = assertFound(await findQuotation(db, id), 'quotation');
      return { ...headerOf(row), stages: (await listStages(db, id)).map(stageDto) };
    },

    async exists(db, id) {
      return (await findQuotation(db, id)) !== undefined;
    },

    async create(input, actor, tx, includeMargin) {
      const { values, stages } = await prepare(tx, input, undefined);
      const id = newId();
      const number = await platform.numbering.next('quotation', tx);
      const row = await insertQuotation(
        tx,
        { id, number, parent_id: null, ...values },
        actor.userId,
        clock.now(),
      );
      await replaceStages(tx, id, stageRows(stages));
      await insertHistory(tx, {
        id: newId(),
        quotationId: id,
        from: null,
        to: 'draft',
        at: clock.now(),
        by: actor.userId,
        note: null,
      });
      await record(tx, actor, {
        action: 'quotations.quotation.create',
        entityType: 'qte_quotation',
        entityId: id,
        after: summaryOf(row, stages.length),
        event: changed(row, 'created'),
      });
      return dtoOf(tx, row, includeMargin);
    },

    async update(id, input, expectedVersion, actor, tx, includeMargin) {
      const existing = await withLock(tx, id, expectedVersion);
      assertEditable(existing.status as QuotationStatus);
      const { values, stages } = await prepare(tx, input, existing);
      const before = summaryOf(existing, (await listStages(tx, id)).length);
      const row = assertUpdated(
        await updateQuotation(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await replaceStages(tx, id, stageRows(stages));
      await record(tx, actor, {
        action: 'quotations.quotation.update',
        entityType: 'qte_quotation',
        entityId: id,
        before,
        after: summaryOf(row, stages.length),
        event: changed(row, 'updated'),
      });
      return dtoOf(tx, row, includeMargin);
    },

    async remove(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, expectedVersion);
      assertEditable(existing.status as QuotationStatus);
      assertApplied(await softDeleteQuotation(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'quotations.quotation.delete',
        entityType: 'qte_quotation',
        entityId: id,
        before: summaryOf(existing, (await listStages(tx, id)).length),
        event: changed(existing, 'deleted'),
      });
    },

    async submit(id, expectedVersion, actor, tx, includeMargin) {
      const existing = await withLock(tx, id, expectedVersion);
      assertTransition(existing.status as QuotationStatus, 'pending_approval');
      const margin = await marginOf(tx, existing);
      // BR-2: the engine always runs; no matching rule is an error raised by the engine.
      await approvals.requestApproval(
        {
          docType: quotationDocType,
          docId: id,
          amount: existing.price,
          requesterId: actor.userId,
          context: {
            number: existing.number,
            revision: existing.revision,
            title: existing.title,
            partyId: existing.party_id,
            sector: existing.sector,
            marginPercent: margin.marginPercent,
            marginFloorPercent: margin.floorPercent,
            belowMarginFloor: margin.belowFloor,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      const row = await moveTo(tx, existing, 'pending_approval', {}, actor.userId, null);
      await record(tx, actor, {
        action: 'quotations.quotation.submit',
        entityType: 'qte_quotation',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status, belowMarginFloor: margin.belowFloor },
        event: changed(row, 'submitted'),
      });
      return dtoOf(tx, row, includeMargin);
    },

    async issue(id, expectedVersion, actor, tx, includeMargin) {
      const existing = await withLock(tx, id, expectedVersion);
      assertTransition(existing.status as QuotationStatus, 'issued');
      const now = clock.now();
      const expiresOn = expiryDate(BusinessDate.fromInstant(now), existing.validity_days);
      const row = await moveTo(
        tx,
        existing,
        'issued',
        { issued_at: now.toISOString(), expires_on: expiresOn.toString() },
        actor.userId,
        null,
      );
      if (existing.parent_id !== null) {
        const parent = assertFound(await findQuotation(tx, existing.parent_id, true), 'quotation');
        const superseded = await moveTo(tx, parent, 'superseded', {}, actor.userId, null);
        await record(tx, actor, {
          action: 'quotations.quotation.supersede',
          entityType: 'qte_quotation',
          entityId: parent.id,
          before: { status: parent.status },
          after: { status: superseded.status },
          event: changed(superseded, 'superseded'),
        });
      }
      await record(tx, actor, {
        action: 'quotations.quotation.issue',
        entityType: 'qte_quotation',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status, issuedAt: now.toISOString(), expiresOn: row.expires_on },
        event: {
          type: 'quotation.issued',
          payload: {
            quotationId: id,
            number: row.number,
            revision: row.revision,
            estimateId: row.estimate_id,
            partyId: row.party_id,
            price: row.price,
            issuedAt: now.toISOString(),
            expiresOn: row.expires_on,
            supersedesQuotationId: existing.parent_id,
          },
        },
      });
      return dtoOf(tx, row, includeMargin);
    },

    async accept(id, input, expectedVersion, actor, tx, includeMargin) {
      const existing = await withLock(tx, id, expectedVersion);
      assertTransition(existing.status as QuotationStatus, 'accepted');
      const acceptedByName = requireText(input.acceptedByName, 'accepted_by_required');
      assertNotPastExpiry(
        isExpired(BusinessDate.parse(existing.expires_on as string), BusinessDate.today(clock)),
      );
      assertAcceptanceProof(
        existing.sector,
        (await files.list(tx, actor, quotationEntityType, id)).length > 0,
      );
      const now = clock.now();
      const row = await moveTo(
        tx,
        existing,
        'accepted',
        { accepted_at: now.toISOString(), accepted_by_name: acceptedByName },
        actor.userId,
        textOrNull(input.note),
      );
      const stages = await stagesOf(tx, id);
      await record(tx, actor, {
        action: 'quotations.quotation.accept',
        entityType: 'qte_quotation',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status, acceptedByName, acceptedAt: now.toISOString() },
        event: {
          type: 'quotation.accepted',
          payload: {
            quotationId: id,
            number: row.number,
            revision: row.revision,
            estimateId: row.estimate_id,
            leadId: row.lead_id,
            partyId: row.party_id,
            sector: row.sector,
            locationId: row.location_id,
            contractValue: row.price,
            acceptedAt: now.toISOString(),
            acceptedByName,
            stages,
          },
        },
      });
      return dtoOf(tx, row, includeMargin);
    },

    async reject(id, reason, expectedVersion, actor, tx, includeMargin) {
      const existing = await withLock(tx, id, expectedVersion);
      assertTransition(existing.status as QuotationStatus, 'rejected');
      const text = requireText(reason, 'reason_required');
      const row = await moveTo(tx, existing, 'rejected', {}, actor.userId, text);
      await record(tx, actor, {
        action: 'quotations.quotation.reject',
        entityType: 'qte_quotation',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status, reason: text },
        event: changed(row, 'rejected'),
      });
      return dtoOf(tx, row, includeMargin);
    },

    async revise(id, actor, tx, includeMargin) {
      const source = assertFound(await findQuotation(tx, id, true), 'quotation');
      assertRevisable(source.status as QuotationStatus);
      assertNoOpenRevision(await openRevisionExists(tx, id));
      const stages = await stagesOf(tx, id);
      const newRowId = newId();
      const row = await insertQuotation(
        tx,
        {
          id: newRowId,
          number: source.number,
          revision: source.revision + 1,
          parent_id: source.id,
          lead_id: source.lead_id,
          estimate_id: source.estimate_id,
          party_id: source.party_id,
          title: source.title,
          sector: source.sector,
          location_id: source.location_id,
          scope_text: source.scope_text,
          inclusions: source.inclusions,
          exclusions: source.exclusions,
          terms: source.terms,
          validity_days: source.validity_days,
          price: source.price,
        },
        actor.userId,
        clock.now(),
      );
      await replaceStages(tx, newRowId, stageRows(stages));
      await insertHistory(tx, {
        id: newId(),
        quotationId: newRowId,
        from: null,
        to: 'draft',
        at: clock.now(),
        by: actor.userId,
        note: null,
      });
      await record(tx, actor, {
        action: 'quotations.quotation.revise',
        entityType: 'qte_quotation',
        entityId: newRowId,
        after: summaryOf(row, stages.length),
        event: changed(row, 'revised'),
      });
      return dtoOf(tx, row, includeMargin);
    },

    async printModel(db, id) {
      const row = assertFound(await findQuotation(db, id), 'quotation');
      const company = assertCompanyProfile(await masterData.company.getCompany(db));
      const party = assertFound(await masterData.getParty(db, row.party_id), 'party');
      const today = BusinessDate.today(clock).toString();
      const registrations = (await masterData.company.listRegistrations(db)).filter(
        (r) => r.validFrom <= today && (r.validTo === null || r.validTo >= today),
      );
      return buildPrintModel({
        company,
        registrations,
        client: { name: party.name, address: party.address, city: party.city },
        quotation: {
          number: displayNumber(row.number, row.revision),
          revision: row.revision,
          title: row.title,
          issuedOn:
            row.issued_at === null ? null : BusinessDate.fromInstant(row.issued_at).toString(),
          expiresOn: row.expires_on,
          validityDays: row.validity_days,
          scopeText: row.scope_text,
          inclusions: row.inclusions,
          exclusions: row.exclusions,
          terms: row.terms,
          price: row.price,
        },
        stages: await stagesOf(db, id),
      });
    },

    async expireDue(tx) {
      const due = await listIssuedExpiredBefore(tx, BusinessDate.today(clock).toString());
      for (const row of due) {
        const expired = await moveTo(tx, row, 'expired', {}, null, null);
        await record(
          tx,
          { userId: null, requestId: null },
          {
            action: 'quotations.quotation.expire',
            entityType: 'qte_quotation',
            entityId: row.id,
            before: { status: row.status, expiresOn: row.expires_on },
            after: { status: expired.status },
            event: changed(expired, 'expired'),
          },
        );
      }
      return due.length;
    },

    async onApprovalOutcome(outcome, payload, tx) {
      const row = await findQuotation(tx, payload.docId, true);
      // Events are delivered at least once: anything but a pending quotation was handled before.
      if (row === undefined || row.status !== 'pending_approval') return;
      const state = await approvals.getApprovalState(tx, quotationDocType, row.id);
      const decidedBy =
        state.status === 'none' ? undefined : state.actions[state.actions.length - 1]?.actorId;
      const by = decidedBy ?? payload.requesterId;
      const to = outcome === 'approved' ? 'approved' : 'draft';
      const next = await moveTo(tx, row, to, {}, by, `approval ${outcome}`);
      await record(
        tx,
        { userId: by, requestId: null },
        {
          action: `quotations.quotation.approval_${outcome}`,
          entityType: 'qte_quotation',
          entityId: row.id,
          before: { status: row.status },
          after: { status: next.status },
          event: changed(next, `approval_${outcome}`),
        },
      );
    },
  };
}
