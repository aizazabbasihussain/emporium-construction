import { ValidationError } from '@emporium/domain';
import { BusinessDate } from '@emporium/domain/kernel';
import { scopeFilter } from '@emporium/domain/identity';
import {
  assertNoRetention,
  assertVariationFits,
  assertVariationTransition,
  assertWorkOrderTransition,
  normalizeContractAmount,
  normalizeVariationAmount,
  remainingCommitment,
} from '@emporium/domain/subcontracts';
import { subcontractOrderDocType, subcontractOrderSeries } from '@emporium/shared';
import {
  assertApplied,
  assertCanCancel,
  assertCanClose,
  assertCloseReason,
  assertCostCodeActive,
  assertDraft,
  assertFound,
  assertNoOpenCertificate,
  assertNotOwnVariation,
  assertOrderActive,
  assertProjectActive,
  assertProjectReachable,
  assertSubcontractor,
  assertUpdated,
  canSeeAmounts,
} from '../policy/subcontracts.policy.js';
import {
  certificateCounts,
  findVariation,
  findWorkOrder,
  insertVariation,
  insertWorkOrder,
  listVariations,
  listWorkOrdersOfParty,
  nextVariationSeq,
  searchWorkOrders,
  softDeleteWorkOrder,
  updateVariation,
  updateWorkOrder,
  type WorkOrderRow,
} from '../repo/subcontracts.repo.js';
import type {
  Actor,
  Db,
  PageResult,
  WorkOrderDto,
  WorkOrderHeaderDto,
  WorkOrderStatus,
  WorkOrderVariationDto,
} from '../types.js';
import type { Context } from './context.js';
import { pageOf, requiredText, textOrNull } from './support.js';
import { approvalOf, figuresOf, headerOf, variationDtoOf } from './views.js';

export interface WorkOrderInput {
  projectId: string;
  partyId: string;
  title: string;
  scopeText?: string | undefined;
  contractAmount: string;
  costCodeId: string;
  startDate?: string | undefined;
  endDate?: string | undefined;
  /** BR-8: must be absent or zero. */
  retentionPercent?: string | undefined;
}

export interface WorkOrderQuery {
  projectId?: string | undefined;
  partyId?: string | undefined;
  status?: WorkOrderStatus | undefined;
  limit: number;
  offset: number;
}

export interface WorkOrderService {
  list(db: Db, query: WorkOrderQuery, actor: Actor): Promise<PageResult<WorkOrderHeaderDto>>;
  get(db: Db, id: string, actor: Actor): Promise<WorkOrderDto>;
  create(input: WorkOrderInput, actor: Actor, tx: Db): Promise<WorkOrderDto>;
  update(
    id: string,
    input: WorkOrderInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<WorkOrderDto>;
  remove(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  submit(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<WorkOrderDto>;
  close(
    id: string,
    input: { reason?: string | undefined; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<WorkOrderDto>;
  cancel(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<WorkOrderDto>;
  addVariation(
    id: string,
    input: { amount: string; reason: string },
    actor: Actor,
    tx: Db,
  ): Promise<WorkOrderVariationDto>;
  updateVariation(
    variationId: string,
    input: { amount: string; reason: string; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<WorkOrderVariationDto>;
  decideVariation(
    variationId: string,
    input: { decision: 'approved' | 'rejected'; note?: string | undefined; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<WorkOrderVariationDto>;
  /** `approval.approved|rejected|returned` of a work order (BR-1). */
  onApprovalOutcome(
    outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
    payload: { docId: string },
    tx: Db,
  ): Promise<void>;
  /** Module interface `getWorkOrder` (spec section 2). */
  getWorkOrder(db: Db, id: string, actor: Actor): Promise<WorkOrderDto>;
  /** Module interface `getCertifiedAmount` (spec section 2): the cumulative gross certified. */
  getCertifiedAmount(db: Db, workOrderId: string): Promise<string>;
  /** The orders of a subcontractor that count for a statement. */
  ordersOfParty(db: Db, partyId: string, actor: Actor): Promise<WorkOrderRow[]>;
  /** Moves the commitment on the cost ledger to `amount` (zero releases it). */
  recommit(tx: Db, row: WorkOrderRow, amount: string, by: string | null): Promise<WorkOrderRow>;
  /** BR-6: the whole contract is certified. */
  complete(tx: Db, row: WorkOrderRow, by: string | null): Promise<WorkOrderRow>;
}

export function createWorkOrderService(ctx: Context): WorkOrderService {
  const { platform, clock, newId, projects, masterData, approvals, record } = ctx;

  const changed = (row: WorkOrderRow, change: string) => ({
    type: 'subcontracts.work_order.changed',
    payload: {
      workOrderId: row.id,
      projectId: row.project_id,
      number: row.number,
      status: row.status,
      change,
    },
  });

  const summaryOf = (row: WorkOrderRow) => ({
    number: row.number,
    status: row.status,
    contractAmount: row.contract_amount,
    title: row.title,
  });

  async function dtoOf(db: Db, row: WorkOrderRow, actor: Actor): Promise<WorkOrderDto> {
    const visible = canSeeAmounts(actor.permissions);
    return {
      ...headerOf(row, await figuresOf(db, row), visible),
      scopeText: row.scope_text,
      costCodeId: row.cost_code_id,
      retentionPercent: row.retention_percent,
      closedOn: row.closed_on,
      closeReason: row.close_reason,
      variations: (await listVariations(db, row.id)).map((v) => variationDtoOf(v, visible)),
      approval: approvalOf(await approvals.getApprovalState(db, subcontractOrderDocType, row.id)),
    };
  }

  /** Locks the order and checks the caller reaches its project and the version is current. */
  async function withLock(
    tx: Db,
    id: string,
    actor: Actor,
    expectedVersion?: number,
  ): Promise<WorkOrderRow> {
    const row = assertFound(await findWorkOrder(tx, id, true), 'work_order');
    assertProjectReachable(actor, row.project_id);
    if (expectedVersion !== undefined && expectedVersion !== row.version) assertUpdated(undefined);
    return row;
  }

  /** BR-1: checks the references of an order and derives the stored fields. */
  async function prepare(tx: Db, input: WorkOrderInput, actor: Actor) {
    assertNoRetention(input.retentionPercent);
    assertProjectReachable(actor, input.projectId);
    assertProjectActive((await projects.getProject(tx, input.projectId)).status);
    assertSubcontractor(await masterData.getParty(tx, input.partyId));
    assertCostCodeActive((await masterData.getCostCode(tx, input.costCodeId)).active);
    const startDate =
      input.startDate === undefined ? null : BusinessDate.parse(input.startDate).toString();
    const endDate =
      input.endDate === undefined ? null : BusinessDate.parse(input.endDate).toString();
    if (startDate !== null && endDate !== null && endDate < startDate) {
      throw new ValidationError('end_before_start', 'The end date is before the start date');
    }
    return {
      project_id: input.projectId,
      party_id: input.partyId,
      title: requiredText(input.title, 'title'),
      scope_text: input.scopeText?.trim() ?? '',
      contract_amount: normalizeContractAmount(input.contractAmount),
      cost_code_id: input.costCodeId,
      start_date: startDate,
      end_date: endDate,
    };
  }

  async function moveTo(
    tx: Db,
    row: WorkOrderRow,
    to: WorkOrderStatus,
    values: Record<string, unknown>,
    by: string | null,
  ): Promise<WorkOrderRow> {
    assertWorkOrderTransition(row.status as WorkOrderStatus, to);
    return assertUpdated(
      await updateWorkOrder(tx, row.id, row.version, { status: to, ...values }, by, clock.now()),
    );
  }

  const service: WorkOrderService = {
    async recommit(tx, row, amount, by) {
      const reason = `Commitment of work order ${row.number} changed`;
      if (row.commitment_entry_id !== null) {
        await projects.reverseCost(row.commitment_entry_id, reason, tx, by);
      }
      let entryId: string | null = null;
      if (Number(amount) > 0) {
        const lineId = newId();
        const entry = await projects.postCost(
          {
            costObject: { type: 'project', id: row.project_id },
            costCodeId: row.cost_code_id,
            amount,
            status: 'committed',
            sourceModule: 'subcontracts',
            sourceDocType: 'subcontract_commitment',
            sourceDocId: row.id,
            sourceLineId: lineId,
            entryDate: ctx.today(),
            description: `Work order ${row.number}`,
            idempotencyKey: `subcontract:commit:${row.id}:${lineId}`,
            actorUserId: by,
          },
          tx,
        );
        entryId = entry.id;
      }
      return assertUpdated(
        await updateWorkOrder(
          tx,
          row.id,
          row.version,
          { commitment_entry_id: entryId, commitment_amount: amount },
          by,
          clock.now(),
        ),
      );
    },

    async complete(tx, row, by) {
      const next = await moveTo(tx, row, 'completed', {}, by);
      await record(
        tx,
        { userId: by, requestId: null },
        {
          action: 'subcontracts.work_order.complete',
          entityType: 'sub_work_order',
          entityId: row.id,
          before: { status: row.status },
          after: { status: next.status },
          event: changed(next, 'completed'),
        },
      );
      return next;
    },

    async list(db, query, actor) {
      const filter = scopeFilter(actor, 'project');
      const { rows, total } = await searchWorkOrders(db, {
        ...query,
        projectIds: filter.all ? undefined : filter.ids,
      });
      const visible = canSeeAmounts(actor.permissions);
      const items: WorkOrderHeaderDto[] = [];
      for (const row of rows) items.push(headerOf(row, await figuresOf(db, row), visible));
      return pageOf(items, total, query);
    },

    async get(db, id, actor) {
      const row = assertFound(await findWorkOrder(db, id), 'work_order');
      assertProjectReachable(actor, row.project_id);
      return dtoOf(db, row, actor);
    },

    async create(input, actor, tx) {
      const values = await prepare(tx, input, actor);
      const row = await insertWorkOrder(
        tx,
        {
          id: newId(),
          number: await platform.numbering.next(subcontractOrderSeries, tx),
          ...values,
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'subcontracts.work_order.create',
        entityType: 'sub_work_order',
        entityId: row.id,
        after: summaryOf(row),
        event: changed(row, 'created'),
      });
      return dtoOf(tx, row, actor);
    },

    async update(id, input, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertDraft(existing.status, 'work_order');
      const values = await prepare(tx, input, actor);
      const row = assertUpdated(
        await updateWorkOrder(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'subcontracts.work_order.update',
        entityType: 'sub_work_order',
        entityId: id,
        before: summaryOf(existing),
        after: summaryOf(row),
        event: changed(row, 'updated'),
      });
      return dtoOf(tx, row, actor);
    },

    async remove(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertDraft(existing.status, 'work_order');
      assertApplied(await softDeleteWorkOrder(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'subcontracts.work_order.delete',
        entityType: 'sub_work_order',
        entityId: id,
        before: summaryOf(existing),
        event: changed(existing, 'deleted'),
      });
    },

    async submit(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertWorkOrderTransition(existing.status as WorkOrderStatus, 'pending_approval');
      assertProjectActive((await projects.getProject(tx, existing.project_id)).status);
      // BR-1: the engine always runs; no matching rule is an error raised by the engine.
      await approvals.requestApproval(
        {
          docType: subcontractOrderDocType,
          docId: id,
          amount: existing.contract_amount,
          requesterId: actor.userId,
          context: {
            number: existing.number,
            title: existing.title,
            projectId: existing.project_id,
            partyId: existing.party_id,
            contractAmount: existing.contract_amount,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      const row = await moveTo(tx, existing, 'pending_approval', {}, actor.userId);
      await record(tx, actor, {
        action: 'subcontracts.work_order.submit',
        entityType: 'sub_work_order',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status },
        event: changed(row, 'submitted'),
      });
      return dtoOf(tx, row, actor);
    },

    async onApprovalOutcome(outcome, payload, tx) {
      const existing = await findWorkOrder(tx, payload.docId, true);
      if (
        existing === undefined ||
        existing.status !== 'pending_approval' ||
        outcome === 'cancelled'
      ) {
        return;
      }
      const system = { userId: null, requestId: null };
      if (outcome !== 'approved') {
        const row = await moveTo(tx, existing, 'draft', {}, null);
        await record(tx, system, {
          action: `subcontracts.work_order.${outcome}`,
          entityType: 'sub_work_order',
          entityId: row.id,
          before: { status: existing.status },
          after: { status: row.status },
          event: changed(row, outcome),
        });
        return;
      }
      // BR-1: the status change is the guard, so the commitment is posted exactly once.
      const active = await moveTo(tx, existing, 'active', {}, null);
      const row = await service.recommit(tx, active, active.contract_amount, null);
      await record(tx, system, {
        action: 'subcontracts.work_order.approved',
        entityType: 'sub_work_order',
        entityId: row.id,
        before: { status: existing.status },
        after: { status: row.status, committed: row.commitment_amount },
        event: {
          type: 'subcontract.committed',
          payload: {
            workOrderId: row.id,
            projectId: row.project_id,
            partyId: row.party_id,
            number: row.number,
            committedAmount: row.commitment_amount,
            costCodeId: row.cost_code_id,
          },
        },
      });
    },

    async close(id, input, actor, tx) {
      const existing = await withLock(tx, id, actor, input.version);
      assertCanClose(existing.status, await certificateCounts(tx, id));
      const reason = textOrNull(input.reason);
      assertCloseReason(Number(existing.commitment_amount) > 0, reason);
      // BR-6: closing releases what is still committed.
      const released = await service.recommit(tx, existing, '0.00', actor.userId);
      const row = await moveTo(
        tx,
        released,
        'closed',
        { closed_on: ctx.today(), close_reason: reason },
        actor.userId,
      );
      await record(tx, actor, {
        action: 'subcontracts.work_order.close',
        entityType: 'sub_work_order',
        entityId: id,
        before: { status: existing.status, committed: existing.commitment_amount },
        after: { status: row.status, reason },
        event: changed(row, 'closed'),
      });
      return dtoOf(tx, row, actor);
    },

    async cancel(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertWorkOrderTransition(existing.status as WorkOrderStatus, 'cancelled');
      assertCanCancel(await certificateCounts(tx, id));
      const released = await service.recommit(tx, existing, '0.00', actor.userId);
      const row = await moveTo(
        tx,
        released,
        'cancelled',
        { cancelled_on: ctx.today() },
        actor.userId,
      );
      await record(tx, actor, {
        action: 'subcontracts.work_order.cancel',
        entityType: 'sub_work_order',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status },
        event: changed(row, 'cancelled'),
      });
      return dtoOf(tx, row, actor);
    },

    async addVariation(id, input, actor, tx) {
      const order = await withLock(tx, id, actor);
      assertOrderActive(order.status);
      const row = await insertVariation(
        tx,
        {
          id: newId(),
          work_order_id: id,
          seq: await nextVariationSeq(tx, id),
          amount: normalizeVariationAmount(input.amount),
          reason: requiredText(input.reason, 'reason'),
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'subcontracts.variation.create',
        entityType: 'sub_work_order_variation',
        entityId: row.id,
        after: { workOrder: order.number, seq: row.seq, amount: row.amount },
        event: changed(order, 'variation_added'),
      });
      return variationDtoOf(row, canSeeAmounts(actor.permissions));
    },

    async updateVariation(variationId, input, actor, tx) {
      const existing = assertFound(await findVariation(tx, variationId, true), 'variation');
      const order = await withLock(tx, existing.work_order_id, actor);
      assertDraft(existing.status, 'variation');
      const row = assertUpdated(
        await updateVariation(
          tx,
          variationId,
          input.version,
          {
            amount: normalizeVariationAmount(input.amount),
            reason: requiredText(input.reason, 'reason'),
          },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'subcontracts.variation.update',
        entityType: 'sub_work_order_variation',
        entityId: variationId,
        before: { amount: existing.amount },
        after: { amount: row.amount },
        event: changed(order, 'variation_updated'),
      });
      return variationDtoOf(row, canSeeAmounts(actor.permissions));
    },

    async decideVariation(variationId, input, actor, tx) {
      const existing = assertFound(await findVariation(tx, variationId, true), 'variation');
      const order = await withLock(tx, existing.work_order_id, actor);
      assertVariationTransition(existing.status as 'draft', input.decision);
      assertNotOwnVariation(actor.userId, existing.created_by);
      assertOrderActive(order.status);
      // The certified amount cannot move while a certificate is open, so the contract is stable.
      assertNoOpenCertificate(await certificateCounts(tx, order.id));
      const note = textOrNull(input.note);
      // The contract and what is certified, before this variation counts.
      const figures = await figuresOf(tx, order);
      const next =
        input.decision === 'approved'
          ? assertVariationFits({
              currentContract: figures.current,
              variation: existing.amount,
              certified: figures.certified,
            })
          : figures.current;
      const row = assertUpdated(
        await updateVariation(
          tx,
          variationId,
          input.version,
          {
            status: input.decision,
            decided_by: actor.userId,
            decided_on: ctx.today(),
            decision_note: note,
          },
          actor.userId,
          clock.now(),
        ),
      );
      if (input.decision === 'approved') {
        // BR-1: an approved variation adds to or reduces the contract and the commitment with it.
        const committed = remainingCommitment(next, figures.certified);
        const recommitted = await service.recommit(tx, order, committed, actor.userId);
        await record(tx, actor, {
          action: 'subcontracts.variation.approve',
          entityType: 'sub_work_order_variation',
          entityId: variationId,
          before: { status: existing.status },
          after: { status: row.status, contract: next, committed },
          event: {
            type: 'subcontract.committed',
            payload: {
              workOrderId: order.id,
              projectId: order.project_id,
              partyId: order.party_id,
              number: order.number,
              committedAmount: recommitted.commitment_amount,
              costCodeId: order.cost_code_id,
              variationId,
            },
          },
        });
      } else {
        await record(tx, actor, {
          action: 'subcontracts.variation.reject',
          entityType: 'sub_work_order_variation',
          entityId: variationId,
          before: { status: existing.status },
          after: { status: row.status, note },
          event: changed(order, 'variation_rejected'),
        });
      }
      return variationDtoOf(row, canSeeAmounts(actor.permissions));
    },

    getWorkOrder: (db, id, actor) => service.get(db, id, actor),

    async getCertifiedAmount(db, workOrderId) {
      return (await figuresOf(db, assertFound(await findWorkOrder(db, workOrderId), 'work_order')))
        .certified;
    },

    async ordersOfParty(db, partyId, actor) {
      const filter = scopeFilter(actor, 'project');
      const rows = await listWorkOrdersOfParty(db, partyId);
      return filter.all ? rows : rows.filter((row) => filter.ids.includes(row.project_id));
    },
  };

  return service;
}
