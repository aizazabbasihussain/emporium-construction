import { assertCountTransition, countVariance } from '@emporium/domain/inventory';
import { D, fmtMoney, fmtQty } from '@emporium/domain/valuation';
import {
  inventorySettingKeys,
  stockAdjustmentDocType,
  type CountStatus,
  type Ownership,
} from '@emporium/shared';
import {
  assertClient,
  assertFound,
  assertKnown,
  assertLossCostCode,
  assertOwnerMatches,
  assertStockable,
  assertStoreActive,
  assertStoreReachable,
  assertUpdated,
} from '../policy/inventory.policy.js';
import {
  balanceOf,
  findCount,
  findStore,
  insertCount,
  insertCountLine,
  listCountLines,
  searchCounts,
  updateCount,
  type CountRow,
} from '../repo/inventory.repo.js';
import type { Actor, CountDto, Db, PageResult } from '../types.js';
import type { Context } from './context.js';
import { pageOf } from './support.js';

export interface CountLineInput {
  itemId: string;
  countedQty: string;
  ownership?: Ownership | undefined;
  ownerPartyId?: string | null | undefined;
}

export interface CountInput {
  storeId: string;
  countedOn: string;
  backdateReason?: string | undefined;
  lines: CountLineInput[];
}

export type CountsService = ReturnType<typeof createCountsService>;

export function createCountsService(ctx: Context) {
  const { clock, record, platform, valuation, projects, approvals, masterData } = ctx;

  const toDto = async (db: Db, row: CountRow): Promise<CountDto> => ({
    id: row.id,
    number: row.number,
    storeId: row.store_id,
    status: row.status as CountStatus,
    countedOn: row.counted_on,
    version: row.version,
    lines: (await listCountLines(db, row.id)).map((line) => ({
      id: line.id,
      itemId: line.item_id,
      ownership: line.ownership as Ownership,
      ownerPartyId: line.owner_party_id,
      systemQty: line.system_qty,
      countedQty: line.counted_qty,
    })),
  });

  const changed = (row: CountRow, action: string) => ({
    type: 'inventory.count.changed',
    payload: { countId: row.id, number: row.number, status: row.status, action },
  });

  async function move(
    tx: Db,
    row: CountRow,
    to: CountStatus,
    by: string | null,
    action: string,
    requestId: string | null,
  ): Promise<CountRow> {
    assertCountTransition(row.status as CountStatus, to);
    const moved = assertUpdated(
      await updateCount(tx, row.id, row.version, { status: to }, by, clock.now()),
    );
    await record(
      tx,
      { userId: by, requestId },
      {
        action: `inventory.count.${action}`,
        entityType: 'inv_count',
        entityId: row.id,
        before: { status: row.status },
        after: { status: moved.status },
        event: changed(moved, action),
      },
    );
    return moved;
  }

  /** BR-8: posts the adjustments of an approved count; the quantity moves by counted less system. */
  async function applyAdjustments(tx: Db, count: CountRow): Promise<void> {
    const lossCostCode = assertLossCostCode(
      await ctx.setting(tx, inventorySettingKeys.stockLossCostCode),
    );
    for (const line of await listCountLines(tx, count.id)) {
      const variance = countVariance(line.system_qty, line.counted_qty);
      if (variance.isZero()) continue;
      const quantity = fmtQty(variance.abs());
      const inbound = variance.greaterThan(0);
      const company = line.ownership === 'company';
      const key = `count-line:${line.id}`;
      let value: string | null = null;
      const parts: {
        quantity: string;
        unitCost: string | null;
        value: string | null;
        layerId: string | null;
      }[] = [];
      if (company && inbound) {
        // An adjustment in comes in at the average cost valuation holds for the key today.
        const average = (await valuation.getStockValue(tx, count.store_id, line.item_id))
          .averageCost;
        const moved = await valuation.recordReceipt(
          {
            storeId: count.store_id,
            itemId: line.item_id,
            quantity,
            unitCost: average,
            postingDate: count.counted_on,
            sourceRef: count.number,
            idempotencyKey: `${key}:val`,
          },
          { userId: null as unknown as string, requestId: null },
          tx,
        );
        value = moved.value;
        parts.push({ quantity, unitCost: moved.unitCost, value, layerId: null });
      } else if (company) {
        await ctx.assertAvailable(
          tx,
          {
            storeId: count.store_id,
            itemId: line.item_id,
            ownership: 'company',
            ownerPartyId: null,
          },
          quantity,
        );
        const moved = await valuation.valueIssue(
          {
            storeId: count.store_id,
            itemId: line.item_id,
            quantity,
            postingDate: count.counted_on,
            sourceRef: count.number,
            idempotencyKey: `${key}:val`,
          },
          { userId: null as unknown as string, requestId: null },
          tx,
        );
        parts.push(...moved.parts);
        value = fmtMoney(parts.reduce((sum, part) => sum.plus(part.value as string), new D(0)));
      } else {
        parts.push({ quantity, unitCost: null, value: null, layerId: null });
      }
      for (const [index, part] of parts.entries()) {
        await ctx.post(tx, {
          storeId: count.store_id,
          itemId: line.item_id,
          ownership: line.ownership as Ownership,
          ownerPartyId: line.owner_party_id,
          type: inbound ? 'adjustment_in' : 'adjustment_out',
          quantity: part.quantity,
          unitCost: part.unitCost,
          value: part.value,
          costObject: inbound || !company ? null : { type: 'overhead', id: null },
          source: { type: 'stock_adjustment', id: count.id, lineId: line.id },
          businessDate: count.counted_on,
          key: `${key}:${index}`,
          by: null,
        });
      }
      if (company && !inbound) {
        await projects.postCost(
          {
            costObject: { type: 'overhead', id: null },
            costCodeId: lossCostCode,
            amount: value as string,
            status: 'posted',
            sourceModule: 'inventory',
            sourceDocType: stockAdjustmentDocType,
            sourceDocId: count.id,
            sourceLineId: line.id,
            entryDate: count.counted_on,
            description: `Stock loss found by count ${count.number}`,
            idempotencyKey: `count-loss:${line.id}`,
            actorUserId: null,
          },
          tx,
        );
      }
      await platform.events.publish(
        {
          type: 'stock.adjusted',
          payload: {
            storeId: count.store_id,
            itemId: line.item_id,
            ownership: line.ownership,
            quantity,
            movementType: inbound ? 'adjustment_in' : 'adjustment_out',
            sourceDocType: stockAdjustmentDocType,
            sourceDocId: count.id,
          },
        },
        tx,
      );
    }
  }

  return {
    async list(
      db: Db,
      query: { status?: CountStatus | undefined; limit: number; offset: number },
    ): Promise<PageResult<CountDto>> {
      const { rows, total } = await searchCounts(db, query);
      return pageOf(await Promise.all(rows.map((row) => toDto(db, row))), total, query);
    },

    async get(db: Db, id: string): Promise<CountDto> {
      return toDto(db, assertFound(await findCount(db, id), 'count'));
    },

    /** A count sheet: the counted quantities next to what the books say right now. */
    async create(input: CountInput, actor: Actor, tx: Db): Promise<CountDto> {
      const store = assertFound(await findStore(tx, input.storeId, true), 'store');
      assertStoreReachable(actor, { projectId: store.project_id });
      assertStoreActive(store.active);
      const date = await ctx.checkDate(
        tx,
        input.countedOn,
        actor,
        'inv_count',
        input.backdateReason,
      );
      const header = await insertCount(
        tx,
        {
          id: ctx.newId(),
          number: await platform.numbering.next('stock_count', tx),
          store_id: store.id,
          counted_on: date,
        },
        actor.userId,
        clock.now(),
      );
      for (const line of input.lines) {
        const ownership = line.ownership ?? 'company';
        const ownerPartyId = line.ownerPartyId ?? null;
        assertOwnerMatches(ownership, ownerPartyId);
        const item = await masterData.getItem(tx, line.itemId);
        assertKnown(item !== undefined, 'item_not_found', 'The item does not exist');
        assertStockable(item as NonNullable<typeof item>);
        if (ownership === 'client')
          assertClient(await masterData.getParty(tx, ownerPartyId as string));
        await insertCountLine(tx, {
          id: ctx.newId(),
          count_id: header.id,
          item_id: line.itemId,
          ownership,
          owner_party_id: ownerPartyId,
          system_qty: await balanceOf(tx, {
            storeId: store.id,
            itemId: line.itemId,
            ownership,
            ownerPartyId,
          }),
          counted_qty: fmtQty(new D(line.countedQty)),
        });
      }
      await record(tx, actor, {
        action: 'inventory.count.create',
        entityType: 'inv_count',
        entityId: header.id,
        after: { number: header.number, lines: input.lines.length },
        event: changed(header, 'created'),
      });
      return toDto(tx, header);
    },

    /** BR-8: a count goes to the owner for approval; refused until the loss cost code is set. */
    async submit(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<CountDto> {
      const row = assertFound(await findCount(tx, id, true), 'count');
      const store = assertFound(await findStore(tx, row.store_id), 'store');
      assertStoreReachable(actor, { projectId: store.project_id });
      if (row.version !== expectedVersion) assertUpdated(undefined);
      assertLossCostCode(await ctx.setting(tx, inventorySettingKeys.stockLossCostCode));
      const moved = await move(tx, row, 'counted', actor.userId, 'submit', actor.requestId);
      await approvals.requestApproval(
        {
          docType: stockAdjustmentDocType,
          docId: id,
          amount: '0.00',
          requesterId: actor.userId,
          context: { number: row.number, storeId: row.store_id },
          requestId: actor.requestId,
        },
        tx,
      );
      return toDto(tx, moved);
    },

    /** The approval engine decided: an approval posts the adjustments, anything else reopens the count. */
    async onApprovalOutcome(
      outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
      payload: { docId: string },
      tx: Db,
    ): Promise<void> {
      const row = await findCount(tx, payload.docId, true);
      if (row?.status !== 'counted') return;
      if (outcome !== 'approved') {
        await move(tx, row, 'draft', null, `approval-${outcome}`, null);
        return;
      }
      await applyAdjustments(tx, row);
      await move(tx, row, 'approved', null, 'approve', null);
    },

    async cancel(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<CountDto> {
      const row = assertFound(await findCount(tx, id, true), 'count');
      const store = assertFound(await findStore(tx, row.store_id), 'store');
      assertStoreReachable(actor, { projectId: store.project_id });
      if (row.version !== expectedVersion) assertUpdated(undefined);
      return toDto(tx, await move(tx, row, 'cancelled', actor.userId, 'cancel', actor.requestId));
    },
  };
}
