import { BusinessDate } from '@emporium/domain/kernel';
import { scopeFilter } from '@emporium/domain/identity';
import {
  addQuantity,
  assertGrnTransition,
  assertPhotoAttached,
  assertPoTransition,
  assertWithinTolerance,
  isReceivable,
  normalizeReceiptLines,
  receiptCost,
  receiptStatus,
  subQuantity,
  type ReceiptLineInput,
} from '@emporium/domain/procurement';
import { grnEntityType, procurementSettingKeys } from '@emporium/shared';
import {
  assertAcceptsReceipts,
  assertDestinationReachable,
  assertFound,
  assertGrnCancellable,
  assertKnown,
  assertUpdated,
} from '../policy/procurement.policy.js';
import {
  findGrn,
  findPo,
  findPoLine,
  insertGrn,
  insertGrnLine,
  listGrnLines,
  listPoLines,
  searchGrns,
  setPoLineReceived,
  updateGrn,
  updatePo,
  type GrnRow,
  type PoLineRow,
  type PoRow,
} from '../repo/procurement.repo.js';
import type {
  Actor,
  Db,
  GoodsReceivedPayload,
  GrnDto,
  GrnHeaderDto,
  GrnStatus,
  PageResult,
  PurchaseOrderStatus,
} from '../types.js';
import type { Commitments } from './commitments.js';
import type { Context } from './context.js';
import { pageOf, requiredText, textOrNull } from './support.js';

export interface GrnPhoto {
  fileName: string;
  bytes: Uint8Array;
}

export interface GrnInput {
  poId: string;
  receivedOn: string;
  deliveryNoteRef?: string | undefined;
  lines: ReceiptLineInput[];
  /** BR-11: the delivery challan photo, attached in the same transaction as the receipt. */
  photos?: GrnPhoto[] | undefined;
}

export interface GrnQuery {
  poId?: string | undefined;
  status?: GrnStatus | undefined;
  limit: number;
  offset: number;
}

export const grnHeaderOf = (row: GrnRow): GrnHeaderDto => ({
  id: row.id,
  number: row.number,
  poId: row.po_id,
  receivedOn: row.received_on,
  receivedBy: row.received_by,
  deliveryNoteRef: row.delivery_note_ref,
  status: row.status as GrnStatus,
  cancelReason: row.cancel_reason,
  version: row.version,
});

export type ReceiptService = ReturnType<typeof createReceiptService>;

export function createReceiptService(ctx: Context, commitments: Commitments) {
  const { clock, record, projects, platform, files } = ctx;

  const changed = (row: GrnRow, action: string) => ({
    type: 'procurement.grn.changed',
    payload: { grnId: row.id, poId: row.po_id, status: row.status, action },
  });

  const destinationOf = (po: Pick<PoRow, 'project_id' | 'store_id'>) =>
    po.project_id === null
      ? ({ type: 'store', id: po.store_id as string } as const)
      : ({ type: 'project', id: po.project_id } as const);

  async function dtoOf(db: Db, row: GrnRow): Promise<GrnDto> {
    return {
      ...grnHeaderOf(row),
      lines: (await listGrnLines(db, row.id)).map((line) => ({
        id: line.id,
        poLineId: line.po_line_id,
        acceptedQty: line.accepted_qty,
        rejectedQty: line.rejected_qty,
        note: line.note,
        costAmount: line.cost_amount,
      })),
    };
  }

  /**
   * BR-7: the order status follows the received quantities. An order that was closed or is being
   * amended keeps its status.
   */
  async function syncOrderStatus(tx: Db, po: PoRow, by: string | null): Promise<PoRow> {
    if (!['approved', 'partly_received', 'received'].includes(po.status)) return po;
    const lines = await listPoLines(tx, po.id);
    const to = receiptStatus(
      lines.map((l) => ({ quantity: l.quantity, receivedQty: l.received_qty })),
    );
    if (to === po.status) return po;
    assertPoTransition(po.status as PurchaseOrderStatus, to);
    return assertUpdated(await updatePo(tx, po.id, po.version, { status: to }, by, clock.now()));
  }

  return {
    async list(db: Db, query: GrnQuery, actor: Actor): Promise<PageResult<GrnHeaderDto>> {
      const scope = scopeFilter(actor, 'project');
      const { rows, total } = await searchGrns(db, {
        ...query,
        projectIds: scope.all ? undefined : scope.ids,
      });
      return pageOf(rows.map(grnHeaderOf), total, query);
    },

    /** Module interface `getGrn` (spec section 2): no caller scope. */
    async find(db: Db, id: string): Promise<GrnDto> {
      return dtoOf(db, assertFound(await findGrn(db, id), 'grn'));
    },

    async get(db: Db, id: string, actor: Actor): Promise<GrnDto> {
      const grn = assertFound(await findGrn(db, id), 'grn');
      const po = assertFound(await findPo(db, grn.po_id), 'purchase_order');
      assertDestinationReachable(actor, destinationOf(po));
      return dtoOf(db, grn);
    },

    async exists(db: Db, id: string): Promise<boolean> {
      return (await findGrn(db, id)) !== undefined;
    },

    /** BR-6, BR-7, BR-11, BR-12 */
    async create(input: GrnInput, actor: Actor, tx: Db): Promise<GrnDto> {
      const po = assertFound(await findPo(tx, input.poId, true), 'purchase_order');
      const destination = destinationOf(po);
      assertDestinationReachable(actor, destination);
      assertAcceptsReceipts(isReceivable(po.status as PurchaseOrderStatus));
      const lines = normalizeReceiptLines(input.lines);
      const tolerance = String(
        (await platform.settings.get(tx, procurementSettingKeys.overReceiptTolerancePercent)).value,
      );

      const grn = await insertGrn(
        tx,
        {
          id: ctx.newId(),
          number: await ctx.numberFor(tx, 'grn', 'GRN'),
          po_id: po.id,
          received_on: input.receivedOn,
          received_by: actor.userId,
          delivery_note_ref: textOrNull(input.deliveryNoteRef),
        },
        actor.userId,
        clock.now(),
      );

      // BR-11: the photo is attached first so the rule can see it; a refusal rolls everything back.
      for (const photo of input.photos ?? []) {
        await files.attach({ entityType: grnEntityType, entityId: grn.id, ...photo }, actor, tx);
      }
      const photoRequired =
        (await platform.settings.get(tx, procurementSettingKeys.grnPhotoRequired)).value === true;
      assertPhotoAttached(
        photoRequired,
        (await files.list(tx, actor, grnEntityType, grn.id)).length,
      );

      const touched: PoLineRow[] = [];
      const received: GoodsReceivedPayload['lines'] = [];
      for (const line of lines) {
        const poLine = await findPoLine(tx, line.poLineId, true);
        assertKnown(
          poLine !== undefined && poLine.po_id === po.id && !poLine.removed,
          'line_not_found',
          'A receipt line is not a line of this order',
        );
        const orderLine = poLine as PoLineRow;
        assertWithinTolerance(
          line.acceptedQty,
          orderLine.quantity,
          orderLine.received_qty,
          tolerance,
        );
        const accepted = Number(line.acceptedQty) > 0;
        const cost = accepted ? receiptCost(line.acceptedQty, orderLine.rate) : '0.00';
        const lineId = ctx.newId();
        // BR-7: the accepted quantity becomes approved cost at the order rate; rejected is neither.
        const entry =
          accepted && destination.type === 'project'
            ? await projects.postCost(
                {
                  costObject: { type: 'project', id: destination.id },
                  costCodeId: orderLine.cost_code_id,
                  amount: cost,
                  status: 'approved',
                  sourceModule: 'procurement',
                  sourceDocType: 'goods_receipt',
                  sourceDocId: grn.id,
                  sourceLineId: lineId,
                  entryDate: BusinessDate.parse(input.receivedOn).toString(),
                  description: `Goods received ${grn.number}`,
                  idempotencyKey: `grn:${lineId}`,
                  actorUserId: actor.userId,
                },
                tx,
              )
            : null;
        await insertGrnLine(tx, {
          id: lineId,
          grnId: grn.id,
          poLineId: orderLine.id,
          acceptedQty: line.acceptedQty,
          rejectedQty: line.rejectedQty,
          note: line.note,
          costAmount: cost,
          costEntryId: entry?.id ?? null,
        });
        await setPoLineReceived(
          tx,
          orderLine.id,
          addQuantity(orderLine.received_qty, line.acceptedQty),
        );
        touched.push(orderLine);
        if (accepted) {
          received.push({
            grnLineId: lineId,
            itemId: orderLine.item_id,
            quantity: line.acceptedQty,
            unitCost: orderLine.rate,
            costCodeId: orderLine.cost_code_id,
          });
        }
      }

      const fresh = await syncOrderStatus(tx, po, actor.userId);
      for (const line of touched) {
        const current = assertFound(await findPoLine(tx, line.id), 'po_line');
        await commitments.recommit(
          tx,
          fresh,
          current,
          `Goods received ${grn.number}`,
          actor.userId,
          `:g${current.commit_seq + 1}`,
        );
      }
      await record(tx, actor, {
        action: 'procurement.grn.create',
        entityType: 'prc_grn',
        entityId: grn.id,
        after: { number: grn.number, poId: po.id, lines: lines.length },
        event: changed(grn, 'posted'),
      });
      const payload: GoodsReceivedPayload = {
        grnId: grn.id,
        grnNumber: grn.number,
        poId: po.id,
        lines: received,
        destinationType: destination.type,
        storeId: po.store_id,
        projectId: po.project_id,
        ownership: 'company',
      };
      await platform.events.publish({ type: 'goods.received', payload }, tx);
      return dtoOf(tx, grn);
    },

    /** BR-8: reverses the cost transitions of a receipt that nobody has used. */
    async cancel(
      id: string,
      reason: string,
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ): Promise<GrnDto> {
      const grn = assertFound(await findGrn(tx, id, true), 'grn');
      const po = assertFound(await findPo(tx, grn.po_id, true), 'purchase_order');
      assertDestinationReachable(actor, destinationOf(po));
      if (grn.version !== expectedVersion) assertUpdated(undefined);
      assertGrnTransition(grn.status as GrnStatus, 'cancelled');
      const why = requiredText(reason, 'reason');
      assertGrnCancellable({
        issued: await ctx.guards.isIssued(tx, id),
        billed: await ctx.guards.isBilled(tx, id),
      });

      const lines = await listGrnLines(tx, id);
      for (const line of lines) {
        if (line.cost_entry_id !== null) {
          await projects.reverseCost(
            line.cost_entry_id,
            `Receipt ${grn.number} cancelled: ${why}`,
            tx,
            actor.userId,
          );
        }
        const poLine = assertFound(await findPoLine(tx, line.po_line_id, true), 'po_line');
        await setPoLineReceived(tx, poLine.id, subQuantity(poLine.received_qty, line.accepted_qty));
      }
      const row = assertUpdated(
        await updateGrn(
          tx,
          id,
          expectedVersion,
          { status: 'cancelled', cancel_reason: why },
          actor.userId,
          clock.now(),
        ),
      );
      const fresh = await syncOrderStatus(tx, po, actor.userId);
      for (const line of lines) {
        const current = assertFound(await findPoLine(tx, line.po_line_id), 'po_line');
        if (['approved', 'partly_received', 'received'].includes(fresh.status)) {
          await commitments.recommit(
            tx,
            fresh,
            current,
            `Receipt ${grn.number} cancelled`,
            actor.userId,
            `:g${current.commit_seq + 1}`,
          );
        }
      }
      await record(tx, actor, {
        action: 'procurement.grn.cancel',
        entityType: 'prc_grn',
        entityId: id,
        before: { status: grn.status },
        after: { status: row.status, reason: why },
        event: changed(row, 'cancelled'),
      });
      await platform.events.publish(
        {
          type: 'goods.receipt.cancelled',
          payload: { grnId: id, poId: po.id, destinationType: po.destination_type },
        },
        tx,
      );
      return dtoOf(tx, row);
    },
  };
}
