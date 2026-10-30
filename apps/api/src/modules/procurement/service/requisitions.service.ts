import {
  assertRequisitionTransition,
  destinationOf,
  lineTotal,
  normalizeRequisitionLines,
  orderedStatus,
  sumMoney,
  type RequisitionLineInput,
} from '@emporium/domain/procurement';
import { scopeFilter } from '@emporium/domain/identity';
import { requisitionDocType } from '@emporium/shared';
import {
  assertDestinationReachable,
  assertFound,
  assertRequisitionDraft,
  assertUpdated,
} from '../policy/procurement.policy.js';
import {
  findRequisition,
  insertRequisition,
  listOpenRequisitionRows,
  listRequisitionLines,
  orderedByLine,
  replaceRequisitionLines,
  searchRequisitions,
  updateRequisition,
  type RequisitionRow,
} from '../repo/procurement.repo.js';
import type {
  Actor,
  Db,
  OpenRequisitionDto,
  PageResult,
  RequisitionDto,
  RequisitionHeaderDto,
  RequisitionStatus,
} from '../types.js';
import type { Context } from './context.js';
import { pageOf, textOrNull } from './support.js';

export interface RequisitionInput {
  projectId?: string | undefined;
  storeId?: string | undefined;
  requiredBy?: string | undefined;
  note?: string | undefined;
  lines: (Omit<RequisitionLineInput, 'unitCode'> & { unitCode?: string | undefined })[];
}

export interface RequisitionQuery {
  status?: RequisitionStatus | undefined;
  projectId?: string | undefined;
  storeId?: string | undefined;
  limit: number;
  offset: number;
}

export const requisitionHeaderOf = (row: RequisitionRow): RequisitionHeaderDto => ({
  id: row.id,
  number: row.number,
  projectId: row.project_id,
  storeId: row.store_id,
  requestedBy: row.requested_by,
  requiredBy: row.required_by,
  status: row.status as RequisitionStatus,
  note: row.note,
  version: row.version,
});

export type RequisitionService = ReturnType<typeof createRequisitionService>;

export function createRequisitionService(ctx: Context) {
  const { clock, approvals, record } = ctx;

  const changed = (row: RequisitionRow, action: string) => ({
    type: 'procurement.requisition.changed',
    payload: { requisitionId: row.id, status: row.status, action },
  });

  async function locked(tx: Db, id: string, actor: Actor, expectedVersion?: number) {
    const row = assertFound(await findRequisition(tx, id, true), 'requisition');
    assertDestinationReachable(
      actor,
      destinationOf({ projectId: row.project_id, storeId: row.store_id }),
    );
    if (expectedVersion !== undefined && expectedVersion !== row.version) assertUpdated(undefined);
    return row;
  }

  async function dtoOf(db: Db, row: RequisitionRow): Promise<RequisitionDto> {
    const ordered = await orderedByLine(db, row.id);
    const state = await approvals.getApprovalState(db, requisitionDocType, row.id);
    return {
      ...requisitionHeaderOf(row),
      lines: (await listRequisitionLines(db, row.id)).map((line) => ({
        id: line.id,
        lineNo: line.line_no,
        itemId: line.item_id,
        description: line.description,
        quantity: line.quantity,
        unitCode: line.unit_code,
        costCodeId: line.cost_code_id,
        estimatedRate: line.estimated_rate,
        orderedQty: ordered.get(line.id) ?? '0.0000',
      })),
      approval:
        state.status === 'none'
          ? { status: 'none', requestId: null, currentRole: null }
          : { status: state.status, requestId: state.id, currentRole: state.currentRole },
    };
  }

  /** Validates the lines against master data and returns them ready to store. */
  async function prepareLines(tx: Db, input: RequisitionInput) {
    const filled: RequisitionLineInput[] = [];
    for (const line of input.lines) {
      const item = await ctx.lineItem(tx, line.itemId);
      await ctx.checkCostCode(tx, line.costCodeId);
      filled.push({ ...line, unitCode: line.unitCode ?? item.unitCode });
    }
    return normalizeRequisitionLines(filled).map((line) => ({
      id: ctx.newId(),
      line_no: line.lineNo,
      item_id: line.itemId,
      description: line.description,
      quantity: line.quantity,
      unit_code: line.unitCode,
      cost_code_id: line.costCodeId,
      estimated_rate: line.estimatedRate,
    }));
  }

  return {
    async list(
      db: Db,
      query: RequisitionQuery,
      actor: Actor,
    ): Promise<PageResult<RequisitionHeaderDto>> {
      const scope = scopeFilter(actor, 'project');
      const { rows, total } = await searchRequisitions(db, {
        ...query,
        projectIds: scope.all ? undefined : scope.ids,
      });
      return pageOf(rows.map(requisitionHeaderOf), total, query);
    },

    /**
     * Module interface `listOpenRequisitions(filter)` (P1-19 BR-3): the requisitions that wait for
     * approval or purchasing, oldest first.
     */
    async listOpen(
      db: Db,
      filter: {
        projectId?: string | undefined;
        storeId?: string | undefined;
        projectIds?: readonly string[] | undefined;
      } = {},
    ): Promise<OpenRequisitionDto[]> {
      return (await listOpenRequisitionRows(db, filter)).map((row) => ({
        ...requisitionHeaderOf(row),
        lineCount: Number(row.line_count),
      }));
    },

    async get(db: Db, id: string, actor: Actor): Promise<RequisitionDto> {
      const row = assertFound(await findRequisition(db, id), 'requisition');
      assertDestinationReachable(
        actor,
        destinationOf({ projectId: row.project_id, storeId: row.store_id }),
      );
      return dtoOf(db, row);
    },

    /** BR-1 */
    async create(input: RequisitionInput, actor: Actor, tx: Db): Promise<RequisitionDto> {
      const destination = destinationOf(input);
      assertDestinationReachable(actor, destination);
      if (destination.type === 'project') await ctx.projects.getProject(tx, destination.id);
      const lines = await prepareLines(tx, input);
      const row = await insertRequisition(
        tx,
        {
          id: ctx.newId(),
          number: await ctx.numberFor(tx, 'requisition', 'REQ'),
          project_id: input.projectId ?? null,
          store_id: input.storeId ?? null,
          requested_by: actor.userId,
          required_by: input.requiredBy ?? null,
          note: textOrNull(input.note) ?? '',
        },
        actor.userId,
        clock.now(),
      );
      await replaceRequisitionLines(tx, row.id, lines);
      await record(tx, actor, {
        action: 'procurement.requisition.create',
        entityType: 'prc_requisition',
        entityId: row.id,
        after: { number: row.number, lines: lines.length },
        event: changed(row, 'created'),
      });
      return dtoOf(tx, row);
    },

    async update(
      id: string,
      input: RequisitionInput,
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ) {
      const existing = await locked(tx, id, actor, expectedVersion);
      assertRequisitionDraft(existing.status as RequisitionStatus);
      const destination = destinationOf(input);
      assertDestinationReachable(actor, destination);
      if (destination.type === 'project') await ctx.projects.getProject(tx, destination.id);
      const lines = await prepareLines(tx, input);
      const row = assertUpdated(
        await updateRequisition(
          tx,
          id,
          expectedVersion,
          {
            project_id: input.projectId ?? null,
            store_id: input.storeId ?? null,
            required_by: input.requiredBy ?? null,
            note: textOrNull(input.note) ?? '',
          },
          actor.userId,
          clock.now(),
        ),
      );
      await replaceRequisitionLines(tx, id, lines);
      await record(tx, actor, {
        action: 'procurement.requisition.update',
        entityType: 'prc_requisition',
        entityId: id,
        before: { number: existing.number },
        after: { number: row.number, lines: lines.length },
        event: changed(row, 'updated'),
      });
      return dtoOf(tx, row);
    },

    /** BR-1: approval through the engine (H-09). */
    async submit(id: string, expectedVersion: number, actor: Actor, tx: Db) {
      const existing = await locked(tx, id, actor, expectedVersion);
      assertRequisitionTransition(existing.status as RequisitionStatus, 'pending_approval');
      const lines = await listRequisitionLines(tx, id);
      await approvals.requestApproval(
        {
          docType: requisitionDocType,
          docId: id,
          amount: sumMoney(
            lines.map((line) => lineTotal(line.quantity, line.estimated_rate ?? '0')),
          ),
          requesterId: actor.userId,
          context: {
            number: existing.number,
            projectId: existing.project_id,
            storeId: existing.store_id,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      return this.move(tx, existing, 'pending_approval', 'submit', actor);
    },

    async cancel(id: string, expectedVersion: number, actor: Actor, tx: Db) {
      const existing = await locked(tx, id, actor, expectedVersion);
      assertRequisitionTransition(existing.status as RequisitionStatus, 'cancelled');
      if (existing.status === 'pending_approval') {
        await approvals.cancelApproval(
          {
            docType: requisitionDocType,
            docId: id,
            reason: 'The requisition was cancelled',
            actorUserId: actor.userId,
            requestId: actor.requestId,
          },
          tx,
        );
      }
      return this.move(tx, existing, 'cancelled', 'cancel', actor);
    },

    async move(
      tx: Db,
      existing: RequisitionRow,
      to: RequisitionStatus,
      action: string,
      actor: { userId: string | null; requestId: string | null },
    ): Promise<RequisitionDto> {
      const row = assertUpdated(
        await updateRequisition(
          tx,
          existing.id,
          existing.version,
          { status: to },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: `procurement.requisition.${action}`,
        entityType: 'prc_requisition',
        entityId: row.id,
        before: { status: existing.status },
        after: { status: row.status },
        event: changed(row, action),
      });
      return dtoOf(tx, row);
    },

    /** The approval engine decided (BR-1); a replayed event finds the requisition already moved. */
    async onApprovalOutcome(
      outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
      payload: { docId: string; requesterId: string },
      tx: Db,
    ): Promise<void> {
      const existing = await findRequisition(tx, payload.docId, true);
      if (existing?.status !== 'pending_approval') return;
      const to =
        outcome === 'approved' ? 'approved' : outcome === 'rejected' ? 'rejected' : 'draft';
      await this.move(tx, existing, to, `approval-${outcome}`, { userId: null, requestId: null });
    },

    /**
     * BR-3: keeps the status of an approved requisition in step with how much of it is on orders.
     * Called by the purchase order service after it creates, changes or cancels an order.
     */
    async refreshOrdered(tx: Db, requisitionId: string, actor: Actor): Promise<void> {
      const existing = assertFound(await findRequisition(tx, requisitionId, true), 'requisition');
      if (!['approved', 'partly_ordered', 'ordered'].includes(existing.status)) return;
      const ordered = await orderedByLine(tx, requisitionId);
      const to = orderedStatus(
        (await listRequisitionLines(tx, requisitionId)).map((line) => ({
          quantity: line.quantity,
          ordered: ordered.get(line.id) ?? '0',
        })),
      );
      if (to !== existing.status) await this.move(tx, existing, to, 'ordered', actor);
    },
  };
}
