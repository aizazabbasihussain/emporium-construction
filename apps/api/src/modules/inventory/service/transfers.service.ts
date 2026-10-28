import { assertTransferTransition } from '@emporium/domain/inventory';
import { D, fmtQty } from '@emporium/domain/valuation';
import type { Ownership, TransferStatus } from '@emporium/shared';
import {
  assertClient,
  assertDifferentStores,
  assertFound,
  assertKnown,
  assertOwnerMatches,
  assertStockable,
  assertStoreActive,
  assertStoreReachable,
  assertUpdated,
} from '../policy/inventory.policy.js';
import {
  findStore,
  findTransfer,
  insertTransfer,
  insertTransferLine,
  listTransferLines,
  searchTransfers,
  updateTransfer,
  type TransferRow,
} from '../repo/inventory.repo.js';
import type { Actor, Db, PageResult, TransferDto } from '../types.js';
import type { Context } from './context.js';
import { pageOf } from './support.js';

export interface TransferLineInput {
  itemId: string;
  quantity: string;
  ownership?: Ownership | undefined;
  ownerPartyId?: string | null | undefined;
  /** The project a client-owned line belongs to, so the client material view keeps it (BR-5). */
  projectId?: string | null | undefined;
}

export interface TransferInput {
  fromStoreId: string;
  toStoreId: string;
  businessDate: string;
  backdateReason?: string | undefined;
  lines: TransferLineInput[];
}

export type TransfersService = ReturnType<typeof createTransfersService>;

export function createTransfersService(ctx: Context) {
  const { clock, record, platform, valuation, masterData } = ctx;

  const toDto = async (db: Db, row: TransferRow): Promise<TransferDto> => ({
    id: row.id,
    number: row.number,
    fromStoreId: row.from_store_id,
    toStoreId: row.to_store_id,
    status: row.status as TransferStatus,
    businessDate: row.business_date,
    version: row.version,
    lines: (await listTransferLines(db, row.id)).map((line) => ({
      id: line.id,
      itemId: line.item_id,
      ownership: line.ownership as Ownership,
      ownerPartyId: line.owner_party_id,
      projectId: line.project_id,
      quantity: line.quantity,
    })),
  });

  const changed = (row: TransferRow, action: string) => ({
    type: 'inventory.transfer.changed',
    payload: { transferId: row.id, number: row.number, status: row.status, action },
  });

  async function reachable(tx: Db, storeId: string, actor: Actor, lock: boolean) {
    const store = assertFound(await findStore(tx, storeId, lock), 'store');
    assertStoreReachable(actor, { projectId: store.project_id });
    return store;
  }

  async function move(
    tx: Db,
    row: TransferRow,
    expectedVersion: number,
    to: TransferStatus,
    actor: Actor,
    action: string,
  ): Promise<TransferRow> {
    if (row.version !== expectedVersion) assertUpdated(undefined);
    assertTransferTransition(row.status as TransferStatus, to);
    const moved = assertUpdated(
      await updateTransfer(tx, row.id, expectedVersion, { status: to }, actor.userId, clock.now()),
    );
    await record(tx, actor, {
      action: `inventory.transfer.${action}`,
      entityType: 'inv_transfer',
      entityId: row.id,
      before: { status: row.status },
      after: { status: moved.status },
      event: changed(moved, action),
    });
    return moved;
  }

  return {
    async list(
      db: Db,
      query: { status?: TransferStatus | undefined; limit: number; offset: number },
    ): Promise<PageResult<TransferDto>> {
      const { rows, total } = await searchTransfers(db, query);
      return pageOf(await Promise.all(rows.map((row) => toDto(db, row))), total, query);
    },

    async get(db: Db, id: string): Promise<TransferDto> {
      return toDto(db, assertFound(await findTransfer(db, id), 'transfer'));
    },

    /** BR-4: a draft transfer names the stores and the lines; nothing moves until it is sent. */
    async create(input: TransferInput, actor: Actor, tx: Db): Promise<TransferDto> {
      assertDifferentStores(input.fromStoreId, input.toStoreId);
      assertStoreActive((await reachable(tx, input.fromStoreId, actor, false)).active);
      assertStoreActive((await reachable(tx, input.toStoreId, actor, false)).active);
      const date = await ctx.checkDate(
        tx,
        input.businessDate,
        actor,
        'inv_transfer',
        input.backdateReason,
      );
      const header = await insertTransfer(
        tx,
        {
          id: ctx.newId(),
          number: await platform.numbering.next('stock_transfer', tx),
          from_store_id: input.fromStoreId,
          to_store_id: input.toStoreId,
          business_date: date,
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
        await insertTransferLine(tx, {
          id: ctx.newId(),
          transfer_id: header.id,
          item_id: line.itemId,
          ownership,
          owner_party_id: ownerPartyId,
          project_id: line.projectId ?? null,
          quantity: fmtQty(new D(line.quantity)),
        });
      }
      await record(tx, actor, {
        action: 'inventory.transfer.create',
        entityType: 'inv_transfer',
        entityId: header.id,
        after: { number: header.number, lines: input.lines.length },
        event: changed(header, 'created'),
      });
      return toDto(tx, header);
    },

    /** BR-4: sending takes the stock out of the source; it is held in transit until received. */
    async send(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<TransferDto> {
      const row = assertFound(await findTransfer(tx, id, true), 'transfer');
      await reachable(tx, row.from_store_id, actor, true);
      await ctx.assertNoNegativeStock(tx);
      const moved = await move(tx, row, expectedVersion, 'in_transit', actor, 'send');
      for (const line of await listTransferLines(tx, id)) {
        await ctx.post(tx, {
          storeId: row.from_store_id,
          itemId: line.item_id,
          ownership: line.ownership as Ownership,
          ownerPartyId: line.owner_party_id,
          type: 'transfer_out',
          quantity: line.quantity,
          costObject: line.project_id === null ? null : { type: 'project', id: line.project_id },
          source: { type: 'transfer', id, lineId: line.id },
          businessDate: row.business_date,
          key: `transfer-out:${line.id}`,
          by: actor.userId,
        });
      }
      return toDto(tx, moved);
    },

    /**
     * BR-4: receiving brings the stock into the destination. Company stock moves through the
     * valuation engine, which carries the source cost to the destination; client stock keeps its
     * owner and carries no cost.
     */
    async receive(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<TransferDto> {
      const row = assertFound(await findTransfer(tx, id, true), 'transfer');
      await reachable(tx, row.to_store_id, actor, true);
      const moved = await move(tx, row, expectedVersion, 'received', actor, 'receive');
      for (const line of await listTransferLines(tx, id)) {
        let unitCost: string | null = null;
        let value: string | null = null;
        if (line.ownership === 'company') {
          const result = await valuation.recordTransfer(
            {
              fromStoreId: row.from_store_id,
              toStoreId: row.to_store_id,
              itemId: line.item_id,
              quantity: line.quantity,
              postingDate: ctx.today(),
              sourceRef: row.number,
              idempotencyKey: `transfer:${line.id}`,
            },
            { userId: actor.userId, requestId: actor.requestId },
            tx,
          );
          unitCost = result.in.unitCost;
          value = result.in.value;
        }
        await ctx.post(tx, {
          storeId: row.to_store_id,
          itemId: line.item_id,
          ownership: line.ownership as Ownership,
          ownerPartyId: line.owner_party_id,
          type: 'transfer_in',
          quantity: line.quantity,
          unitCost,
          value,
          costObject: line.project_id === null ? null : { type: 'project', id: line.project_id },
          source: { type: 'transfer', id, lineId: line.id },
          businessDate: ctx.today(),
          key: `transfer-in:${line.id}`,
          by: actor.userId,
        });
      }
      return toDto(tx, moved);
    },

    /** T-5: a draft is dropped; an in-transit transfer puts the stock back at the source. */
    async cancel(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<TransferDto> {
      const row = assertFound(await findTransfer(tx, id, true), 'transfer');
      await reachable(tx, row.from_store_id, actor, true);
      const wasSent = row.status === 'in_transit';
      const moved = await move(tx, row, expectedVersion, 'cancelled', actor, 'cancel');
      if (wasSent) {
        for (const line of await listTransferLines(tx, id)) {
          await ctx.post(tx, {
            storeId: row.from_store_id,
            itemId: line.item_id,
            ownership: line.ownership as Ownership,
            ownerPartyId: line.owner_party_id,
            type: 'transfer_in',
            quantity: line.quantity,
            costObject: line.project_id === null ? null : { type: 'project', id: line.project_id },
            source: { type: 'transfer_cancel', id, lineId: line.id },
            businessDate: ctx.today(),
            key: `transfer-cancel:${line.id}`,
            by: actor.userId,
          });
        }
      }
      return toDto(tx, moved);
    },
  };
}
