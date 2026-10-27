import { ValidationError } from '@emporium/domain';
import {
  assertNotBelowReceived,
  assertPoTransition,
  destinationOf,
  normalizePoLines,
  receiptStatus,
  type PoLineInput,
} from '@emporium/domain/procurement';
import { purchaseOrderDocType } from '@emporium/shared';
import {
  assertFound,
  assertKnown,
  assertPoAmendable,
  assertPoCancellable,
  assertPoClosable,
  assertPoDraft,
  assertRequisitionOrderable,
  assertUpdated,
} from '../policy/procurement.policy.js';
import {
  deletePoLine,
  findPo,
  findRequisition,
  findRfq,
  hasGrnLines,
  hasPostedReceipt,
  insertPo,
  insertPoLine,
  listOpenLines,
  listPoLines,
  listQuoteLines,
  listQuotes,
  listRequisitionLines,
  listSelections,
  markPoLineRemoved,
  orderedByLine,
  searchPos,
  shiftPoLineNumbers,
  updatePo,
  updatePoLine,
  type PoLineRow,
  type PoRow,
} from '../repo/procurement.repo.js';
import type {
  Actor,
  Db,
  OpenPoLineDto,
  PageResult,
  PoDto,
  PoHeaderDto,
  PrintModelDto,
  PurchaseOrderStatus,
  RequisitionStatus,
} from '../types.js';
import type { Commitments } from './commitments.js';
import type { Context } from './context.js';
import type { RequisitionService } from './requisitions.service.js';
import { pageOf, textOrNull } from './support.js';

export interface PoLineDraft {
  /** The existing line this one replaces; omitted for a new line. */
  lineId?: string | undefined;
  itemId: string;
  description?: string | undefined;
  quantity: string;
  unitCode?: string | undefined;
  rate: string;
  costCodeId: string;
  /** Set only for an order made from the selections of a request for quotation. */
  requisitionLineId?: string | undefined;
}

export interface PoInput {
  vendorId: string;
  projectId?: string | undefined;
  storeId?: string | undefined;
  orderDate: string;
  expectedDate?: string | undefined;
  terms?: string | undefined;
  lines: PoLineDraft[];
}

export interface PoFromRfqInput {
  rfqId: string;
  vendorId: string;
  orderDate: string;
  expectedDate?: string | undefined;
  terms?: string | undefined;
}

export interface PoQuery {
  status?: PurchaseOrderStatus | undefined;
  vendorId?: string | undefined;
  projectId?: string | undefined;
  limit: number;
  offset: number;
}

export const poHeaderOf = (row: PoRow): PoHeaderDto => ({
  id: row.id,
  number: row.number,
  revision: row.revision,
  vendorId: row.vendor_id,
  requisitionId: row.requisition_id,
  destinationType: row.destination_type as 'project' | 'store',
  projectId: row.project_id,
  storeId: row.store_id,
  orderDate: row.order_date,
  expectedDate: row.expected_date,
  status: row.status as PurchaseOrderStatus,
  total: row.total,
  terms: row.terms,
  version: row.version,
});

const lineOf = (line: PoLineRow) => ({
  id: line.id,
  lineNo: line.line_no,
  requisitionLineId: line.requisition_line_id,
  itemId: line.item_id,
  description: line.description,
  quantity: line.quantity,
  unitCode: line.unit_code,
  rate: line.rate,
  lineTotal: line.line_total,
  costCodeId: line.cost_code_id,
  receivedQty: line.received_qty,
});

export type OrderService = ReturnType<typeof createOrderService>;

export function createOrderService(
  ctx: Context,
  requisitions: Pick<RequisitionService, 'refreshOrdered'>,
  commitments: Commitments,
) {
  const { clock, approvals, record, projects } = ctx;

  const changed = (row: PoRow, action: string) => ({
    type: 'procurement.po.changed',
    payload: { poId: row.id, status: row.status, revision: row.revision, action },
  });

  /** The facts other modules need when an order is approved or cancelled (spec section 2). */
  const facts = (row: PoRow) => ({
    poId: row.id,
    number: row.number,
    revision: row.revision,
    vendorId: row.vendor_id,
    total: row.total,
    destinationType: row.destination_type,
    projectId: row.project_id,
    storeId: row.store_id,
  });

  async function dtoOf(db: Db, row: PoRow): Promise<PoDto> {
    const state = await approvals.getApprovalState(db, purchaseOrderDocType, row.id);
    return {
      ...poHeaderOf(row),
      lines: (await listPoLines(db, row.id)).map(lineOf),
      approval:
        state.status === 'none'
          ? { status: 'none', requestId: null, currentRole: null }
          : { status: state.status, requestId: state.id, currentRole: state.currentRole },
    };
  }

  async function locked(tx: Db, id: string, expectedVersion?: number): Promise<PoRow> {
    const row = assertFound(await findPo(tx, id, true), 'purchase_order');
    if (expectedVersion !== undefined && expectedVersion !== row.version) assertUpdated(undefined);
    return row;
  }

  async function move(
    tx: Db,
    existing: PoRow,
    to: PurchaseOrderStatus,
    action: string,
    actor: { userId: string | null; requestId: string | null },
    extra: Record<string, unknown> = {},
    events: { type: string; payload: unknown }[] = [],
  ): Promise<PoRow> {
    assertPoTransition(existing.status as PurchaseOrderStatus, to);
    const row = assertUpdated(
      await updatePo(
        tx,
        existing.id,
        existing.version,
        { status: to, ...extra },
        actor.userId,
        clock.now(),
      ),
    );
    await record(tx, actor, {
      action: `procurement.po.${action}`,
      entityType: 'prc_purchase_order',
      entityId: row.id,
      before: { status: existing.status, revision: existing.revision },
      after: { status: row.status, revision: row.revision },
      event: changed(row, action),
    });
    for (const event of events) await ctx.platform.events.publish(event, tx);
    return row;
  }

  /** BR-10: checks the vendor, items and cost codes and fills in the units. */
  async function prepare(tx: Db, lines: PoLineDraft[]): Promise<PoLineInput[]> {
    const prepared: PoLineInput[] = [];
    for (const line of lines) {
      const item = await ctx.lineItem(tx, line.itemId);
      await ctx.checkCostCode(tx, line.costCodeId);
      prepared.push({ ...line, unitCode: line.unitCode ?? item.unitCode });
    }
    return prepared;
  }

  /**
   * Stores the lines of an order. A line that carries `lineId` keeps its received quantity and its
   * commitment (BR-5); a line that is left out is removed, but one that has been received cannot be.
   */
  async function writeLines(tx: Db, po: PoRow, drafts: PoLineDraft[]): Promise<string> {
    const { lines, total } = normalizePoLines(await prepare(tx, drafts));
    const existing = new Map((await listPoLines(tx, po.id)).map((line) => [line.id, line]));
    const kept = new Set<string>();
    await shiftPoLineNumbers(tx, po.id, lines.length);
    for (const [index, line] of lines.entries()) {
      const { lineNo, ...rest } = line;
      const lineId = (drafts[index] as PoLineDraft).lineId;
      if (lineId === undefined) {
        await insertPoLine(tx, po.id, { id: ctx.newId(), lineNo, ...rest });
        continue;
      }
      const old = existing.get(lineId);
      assertKnown(
        old !== undefined && !kept.has(lineId),
        'line_not_found',
        'A line of the order was not found',
      );
      assertNotBelowReceived(line.quantity, (old as PoLineRow).received_qty);
      kept.add(lineId);
      await updatePoLine(tx, lineId, {
        lineNo,
        ...rest,
        requisitionLineId: rest.requisitionLineId ?? (old as PoLineRow).requisition_line_id,
      });
    }
    for (const old of existing.values()) {
      if (kept.has(old.id)) continue;
      if (Number(old.received_qty) > 0) {
        throw new ValidationError('line_received', 'A line that was received cannot be removed');
      }
      if (old.commit_entry_id === null && !(await hasGrnLines(tx, old.id))) {
        await deletePoLine(tx, old.id);
      } else {
        await markPoLineRemoved(tx, old.id);
      }
    }
    return total;
  }

  async function createOrder(
    tx: Db,
    actor: Actor,
    header: {
      vendorId: string;
      requisitionId: string | null;
      projectId?: string | undefined;
      storeId?: string | undefined;
      orderDate: string;
      expectedDate?: string | undefined;
      terms?: string | undefined;
    },
    drafts: PoLineDraft[],
  ): Promise<PoDto> {
    const destination = destinationOf(header);
    await ctx.checkVendor(tx, header.vendorId);
    if (destination.type === 'project') await projects.getProject(tx, destination.id);
    const row = await insertPo(
      tx,
      {
        id: ctx.newId(),
        number: await ctx.platform.numbering.next('purchase_order', tx),
        vendor_id: header.vendorId,
        requisition_id: header.requisitionId,
        project_id: header.projectId ?? null,
        store_id: header.storeId ?? null,
        destination_type: destination.type,
        order_date: header.orderDate,
        expected_date: header.expectedDate ?? null,
        terms: textOrNull(header.terms) ?? '',
      },
      actor.userId,
      clock.now(),
    );
    assertKnown(
      drafts.every((line) => line.lineId === undefined),
      'line_not_found',
      'A new order has no existing lines',
    );
    const total = await writeLines(tx, row, drafts);
    const saved = assertUpdated(
      await updatePo(tx, row.id, row.version, { total }, actor.userId, clock.now()),
    );
    await record(tx, actor, {
      action: 'procurement.po.create',
      entityType: 'prc_purchase_order',
      entityId: row.id,
      after: { number: row.number, total },
      event: changed(saved, 'created'),
    });
    if (header.requisitionId !== null)
      await requisitions.refreshOrdered(tx, header.requisitionId, actor);
    return dtoOf(tx, saved);
  }

  /** The commitments of every line follow the lines as they now stand (BR-4, BR-5). */
  async function commitAll(tx: Db, po: PoRow, reason: string, by: string | null) {
    for (const line of await listPoLines(tx, po.id, { withRemoved: true })) {
      await commitments.recommit(tx, po, line, reason, by);
    }
  }

  async function releaseAll(tx: Db, po: PoRow, reason: string, by: string | null) {
    for (const line of await listPoLines(tx, po.id, { withRemoved: true })) {
      await commitments.release(tx, line, reason, by);
    }
  }

  return {
    async list(db: Db, query: PoQuery): Promise<PageResult<PoHeaderDto>> {
      const { rows, total } = await searchPos(db, query);
      return pageOf(rows.map(poHeaderOf), total, query);
    },

    /** Module interface `getPurchaseOrder` (spec section 2). */
    async get(db: Db, id: string): Promise<PoDto> {
      return dtoOf(db, assertFound(await findPo(db, id), 'purchase_order'));
    },

    /** Module interface `listOpenPoLines` (spec section 2). */
    async listOpenLines(
      db: Db,
      filter: {
        vendorId?: string | undefined;
        projectId?: string | undefined;
        storeId?: string | undefined;
      } = {},
    ): Promise<OpenPoLineDto[]> {
      return (await listOpenLines(db, filter)).map((row) => ({
        poId: row.po_id,
        poNumber: row.po_number,
        vendorId: row.vendor_id,
        lineId: row.line_id,
        lineNo: row.line_no,
        itemId: row.item_id,
        orderedQty: row.quantity,
        receivedQty: row.received_qty,
        openQty: (Number(row.quantity) - Number(row.received_qty)).toFixed(4),
        rate: row.rate,
        expectedDate: row.expected_date,
        destinationType: row.destination_type as 'project' | 'store',
        projectId: row.project_id,
        storeId: row.store_id,
      }));
    },

    /** BR-3: a manual order. */
    create: (input: PoInput, actor: Actor, tx: Db): Promise<PoDto> =>
      createOrder(tx, actor, { ...input, requisitionId: null }, input.lines),

    /** BR-3: an order from the selections made on a request for quotation. */
    async createFromRfq(input: PoFromRfqInput, actor: Actor, tx: Db): Promise<PoDto> {
      const rfq = assertFound(await findRfq(tx, input.rfqId), 'rfq');
      const requisition = assertFound(await findRequisition(tx, rfq.requisition_id), 'requisition');
      assertRequisitionOrderable(requisition.status as RequisitionStatus);
      const quotes = new Map((await listQuotes(tx, rfq.id)).map((quote) => [quote.id, quote]));
      const rates = new Map(
        (await listQuoteLines(tx, rfq.id)).map((line) => [
          `${line.quote_id}:${line.requisition_line_id}`,
          line.rate,
        ]),
      );
      const chosen = new Map(
        (await listSelections(tx, rfq.id))
          .filter((selection) => quotes.get(selection.quote_id)?.vendor_id === input.vendorId)
          .map((selection) => [selection.requisition_line_id, selection.quote_id]),
      );
      const ordered = await orderedByLine(tx, requisition.id);
      const drafts: PoLineDraft[] = [];
      for (const line of await listRequisitionLines(tx, requisition.id)) {
        const open = Number(line.quantity) - Number(ordered.get(line.id) ?? 0);
        const quoteId = chosen.get(line.id);
        if (quoteId === undefined || open <= 0) continue;
        drafts.push({
          itemId: line.item_id,
          description: line.description,
          quantity: open.toFixed(4),
          unitCode: line.unit_code,
          rate: rates.get(`${quoteId}:${line.id}`) as string,
          costCodeId: line.cost_code_id,
          requisitionLineId: line.id,
        });
      }
      assertKnown(
        drafts.length > 0,
        'nothing_to_order',
        'No selected line of this vendor is left to order',
      );
      return createOrder(
        tx,
        actor,
        {
          vendorId: input.vendorId,
          requisitionId: requisition.id,
          projectId: requisition.project_id ?? undefined,
          storeId: requisition.store_id ?? undefined,
          orderDate: input.orderDate,
          expectedDate: input.expectedDate,
          terms: input.terms,
        },
        drafts,
      );
    },

    async update(
      id: string,
      input: PoInput,
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ): Promise<PoDto> {
      const existing = await locked(tx, id, expectedVersion);
      assertPoDraft(existing.status as PurchaseOrderStatus);
      const destination = destinationOf(input);
      await ctx.checkVendor(tx, input.vendorId);
      if (destination.type === 'project') await projects.getProject(tx, destination.id);
      const total = await writeLines(tx, existing, input.lines);
      const row = assertUpdated(
        await updatePo(
          tx,
          id,
          expectedVersion,
          {
            vendor_id: input.vendorId,
            project_id: input.projectId ?? null,
            store_id: input.storeId ?? null,
            destination_type: destination.type,
            order_date: input.orderDate,
            expected_date: input.expectedDate ?? null,
            terms: textOrNull(input.terms) ?? '',
            total,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'procurement.po.update',
        entityType: 'prc_purchase_order',
        entityId: id,
        before: { total: existing.total },
        after: { total },
        event: changed(row, 'updated'),
      });
      return dtoOf(tx, row);
    },

    /** BR-4: approval through the engine (doc type purchase_order, amount = total). */
    async submit(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<PoDto> {
      const existing = await locked(tx, id, expectedVersion);
      assertPoTransition(existing.status as PurchaseOrderStatus, 'pending_approval');
      await approvals.requestApproval(
        {
          docType: purchaseOrderDocType,
          docId: id,
          amount: existing.total,
          requesterId: actor.userId,
          context: {
            number: existing.number,
            revision: existing.revision,
            vendorId: existing.vendor_id,
            projectId: existing.project_id,
            storeId: existing.store_id,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      return dtoOf(tx, await move(tx, existing, 'pending_approval', 'submit', actor));
    },

    /**
     * BR-5: an approved order is amended into a new version. Its commitments stay as they are until
     * the new version is approved; received quantities can never be reduced below what came in.
     */
    async amend(
      id: string,
      input: PoInput,
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ): Promise<PoDto> {
      const existing = await locked(tx, id, expectedVersion);
      assertPoAmendable(existing.status as PurchaseOrderStatus);
      assertPoTransition(existing.status as PurchaseOrderStatus, 'draft');
      const destination = destinationOf(input);
      assertKnown(
        destination.type === existing.destination_type &&
          destination.id === (existing.project_id ?? existing.store_id),
        'destination_fixed',
        'The destination of an approved order cannot change',
      );
      await ctx.checkVendor(tx, input.vendorId);
      const total = await writeLines(tx, existing, input.lines);
      const row = assertUpdated(
        await updatePo(
          tx,
          id,
          expectedVersion,
          {
            status: 'draft',
            revision: existing.revision + 1,
            vendor_id: input.vendorId,
            order_date: input.orderDate,
            expected_date: input.expectedDate ?? null,
            terms: textOrNull(input.terms) ?? '',
            total,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'procurement.po.amend',
        entityType: 'prc_purchase_order',
        entityId: id,
        before: { status: existing.status, revision: existing.revision, total: existing.total },
        after: { status: row.status, revision: row.revision, total },
        event: changed(row, 'amended'),
      });
      if (row.requisition_id !== null)
        await requisitions.refreshOrdered(tx, row.requisition_id, actor);
      return dtoOf(tx, row);
    },

    /** BR-9: closing releases whatever is still committed. */
    async close(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<PoDto> {
      const existing = await locked(tx, id, expectedVersion);
      assertPoClosable(existing.status as PurchaseOrderStatus);
      await releaseAll(tx, existing, 'The purchase order was closed', actor.userId);
      return dtoOf(tx, await move(tx, existing, 'closed', 'close', actor));
    },

    async cancel(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<PoDto> {
      const existing = await locked(tx, id, expectedVersion);
      assertPoTransition(existing.status as PurchaseOrderStatus, 'cancelled');
      assertPoCancellable(await hasPostedReceipt(tx, id));
      if (existing.status === 'pending_approval') {
        await approvals.cancelApproval(
          {
            docType: purchaseOrderDocType,
            docId: id,
            reason: 'The purchase order was cancelled',
            actorUserId: actor.userId,
            requestId: actor.requestId,
          },
          tx,
        );
      }
      await releaseAll(tx, existing, 'The purchase order was cancelled', actor.userId);
      const row = await move(tx, existing, 'cancelled', 'cancel', actor, {}, [
        { type: 'po.cancelled', payload: facts(existing) },
      ]);
      if (row.requisition_id !== null)
        await requisitions.refreshOrdered(tx, row.requisition_id, actor);
      return dtoOf(tx, row);
    },

    /**
     * The approval engine decided (BR-4). Approval commits the lines to the project and announces
     * `po.approved`; a rejected, returned or cancelled request sends the order back to a draft. A
     * replayed event finds the order already moved.
     */
    async onApprovalOutcome(
      outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
      payload: { docId: string; requesterId: string },
      tx: Db,
    ): Promise<void> {
      const existing = await findPo(tx, payload.docId, true);
      if (existing?.status !== 'pending_approval') return;
      const system = { userId: null, requestId: null };
      if (outcome !== 'approved') {
        await move(tx, existing, 'draft', `approval-${outcome}`, system);
        return;
      }
      await commitAll(tx, existing, 'The purchase order was approved', payload.requesterId);
      const lines = await listPoLines(tx, existing.id);
      const to = receiptStatus(
        lines.map((l) => ({ quantity: l.quantity, receivedQty: l.received_qty })),
      );
      await move(tx, existing, to, 'approve', system, {}, [
        { type: 'po.approved', payload: facts(existing) },
      ]);
    },

    /** The order the print layout shows (BR-3). */
    async printModel(db: Db, id: string): Promise<PrintModelDto> {
      const po = await this.get(db, id);
      const vendor = assertFound(await ctx.masterData.getParty(db, po.vendorId), 'vendor');
      return {
        number: po.number,
        revision: po.revision,
        status: po.status,
        orderDate: po.orderDate,
        expectedDate: po.expectedDate,
        vendor: { id: vendor.id, name: vendor.name, address: vendor.address, phone: vendor.phone },
        destination: { type: po.destinationType, projectId: po.projectId, storeId: po.storeId },
        terms: po.terms,
        lines: po.lines.map(
          ({ lineNo, itemId, description, quantity, unitCode, rate, lineTotal }) => ({
            lineNo,
            itemId,
            description,
            quantity,
            unitCode,
            rate,
            lineTotal,
          }),
        ),
        total: po.total,
      };
    },
  };
}
