import {
  assertReturnable,
  remainingIssueCost,
  salvageValue,
  sumParts,
} from '@emporium/domain/inventory';
import { SALVAGE_DOC_TYPE } from '@emporium/domain/costing';
import { scopeFilter } from '@emporium/domain/identity';
import { D, fmtMoney, fmtQty } from '@emporium/domain/valuation';
import { inventorySettingKeys, type Ownership } from '@emporium/shared';
import {
  assertClient,
  assertCostCodeKnown,
  assertFound,
  assertKnown,
  assertMayIssue,
  assertOwnerMatches,
  assertProjectOpen,
  assertStockable,
  assertStoreActive,
  assertStoreReachable,
} from '../policy/inventory.policy.js';
import {
  balanceOf,
  findIssue,
  findIssueByKey,
  findStore,
  hasOutflowSince,
  insertIssue,
  integrityRows,
  listBalances,
  listBelowReorderRows,
  listClientMaterial,
  listLedgerBySource,
  recordIssueReturn,
  searchLedger,
  searchStock,
  type IssueRow,
  type LedgerRow,
  type StockFilter,
  type StoreRow,
} from '../repo/inventory.repo.js';
import type {
  Actor,
  BelowReorderDto,
  ClientMaterialDto,
  Db,
  IntegrityReport,
  LedgerDto,
  MovementDto,
  PageResult,
  StockDto,
  StockEventPayload,
  StockValueRowDto,
} from '../types.js';
import type { Context } from './context.js';
import { ledgerDtoOf, pageOf } from './support.js';

export interface CostObjectRef {
  type: 'project' | 'work_order' | 'overhead';
  id: string | null;
}

interface Command {
  businessDate: string;
  backdateReason?: string | undefined;
  /** A repeat with the same key returns the first result (constitution 5.10). */
  idempotencyKey?: string | undefined;
  note?: string | undefined;
}

export interface IssueCommand extends Command {
  storeId: string;
  itemId: string;
  quantity: string;
  ownership?: Ownership | undefined;
  ownerPartyId?: string | null | undefined;
  costObject: CostObjectRef;
  costCodeId?: string | undefined;
}

export interface ReturnCommand extends Command {
  issueId: string;
  quantity: string;
}

export interface ClientCommand extends Command {
  storeId: string;
  itemId: string;
  quantity: string;
  ownerPartyId: string;
  projectId: string;
}

export interface SalvageCommand extends Command {
  storeId: string;
  itemId: string;
  quantity: string;
  projectId?: string | undefined;
  costCodeId?: string | undefined;
  /** Needed when the setting `salvage_value_mode` is `estimated` (H-21). */
  unitValue?: string | undefined;
}

export interface GoodsReceivedEvent {
  grnId: string;
  grnNumber: string;
  lines: { grnLineId: string; itemId: string; quantity: string; unitCost: string }[];
  destinationType: 'project' | 'store';
  storeId: string | null;
  ownership: 'company';
}

export interface StockQuery {
  storeId?: string | undefined;
  itemId?: string | undefined;
  ownership?: Ownership | undefined;
  limit: number;
  offset: number;
}

export interface LedgerQuery extends StockQuery {
  movementType?: string | undefined;
}

export type StockService = ReturnType<typeof createStockService>;

export function createStockService(ctx: Context) {
  const { clock, record, valuation, projects, masterData } = ctx;

  const eventOf = (
    type: 'stock.issued' | 'stock.received' | 'stock.adjusted',
    row: LedgerRow,
    quantity: string,
  ) => ({
    type,
    payload: {
      storeId: row.store_id,
      itemId: row.item_id,
      ownership: row.ownership as Ownership,
      quantity,
      movementType: row.movement_type as StockEventPayload['movementType'],
      sourceDocType: row.source_doc_type,
      sourceDocId: row.source_doc_id,
    } satisfies StockEventPayload,
  });

  async function activeStore(
    tx: Db,
    storeId: string,
    actor: Pick<Actor, 'roles' | 'scopes'>,
  ): Promise<StoreRow> {
    const store = assertFound(await findStore(tx, storeId, true), 'store');
    assertStoreReachable(actor, { projectId: store.project_id });
    assertStoreActive(store.active);
    return store;
  }

  async function stockItem(tx: Db, itemId: string) {
    const item = await masterData.getItem(tx, itemId);
    assertKnown(item !== undefined, 'item_not_found', 'The item does not exist');
    const found = item as NonNullable<typeof item>;
    assertStockable(found);
    return found;
  }

  async function movementOf(tx: Db, issue: IssueRow): Promise<MovementDto> {
    const rows = await listLedgerBySource(tx, 'issue', issue.id);
    return {
      id: issue.id,
      storeId: issue.store_id,
      itemId: issue.item_id,
      ownership: issue.ownership as Ownership,
      quantity: issue.quantity,
      value: issue.value,
      costEntryId: issue.cost_entry_id,
      ledger: rows.map(ledgerDtoOf),
    };
  }

  const ledgerMovement = (id: string, row: LedgerRow): MovementDto => ({
    id,
    storeId: row.store_id,
    itemId: row.item_id,
    ownership: row.ownership as Ownership,
    quantity: fmtQty(new D(row.quantity).abs()),
    value: row.value,
    costEntryId: null,
    ledger: [ledgerDtoOf(row)],
  });

  return {
    /**
     * BR-2: stock from a goods receipt enters the destination store at the unit cost of the order.
     * Idempotent on the receipt line id, so a replayed event changes nothing.
     */
    async receiveFromGrn(payload: GoodsReceivedEvent, tx: Db): Promise<void> {
      if (payload.destinationType !== 'store' || payload.storeId === null) return;
      const store = assertFound(await findStore(tx, payload.storeId, true), 'store');
      const date = ctx.today();
      for (const line of payload.lines) {
        const key = `grn-line:${line.grnLineId}`;
        const item = await masterData.getItem(tx, line.itemId);
        assertKnown(item !== undefined, 'item_not_found', 'The item does not exist');
        assertStockable(item as NonNullable<typeof item>);
        const moved = await valuation.recordReceipt(
          {
            storeId: store.id,
            itemId: line.itemId,
            quantity: line.quantity,
            unitCost: line.unitCost,
            postingDate: date,
            sourceRef: payload.grnNumber,
            idempotencyKey: `${key}:val`,
          },
          { userId: null as unknown as string, requestId: null },
          tx,
        );
        const { row, repeated } = await ctx.post(tx, {
          storeId: store.id,
          itemId: line.itemId,
          ownership: 'company',
          ownerPartyId: null,
          type: 'receipt',
          quantity: line.quantity,
          unitCost: line.unitCost,
          value: moved.value,
          source: { type: 'grn', id: payload.grnId, lineId: line.grnLineId },
          businessDate: date,
          key,
          by: null,
        });
        if (repeated) continue;
        await record(
          tx,
          { userId: null, requestId: null },
          {
            action: 'inventory.stock.receive',
            entityType: 'inv_ledger',
            entityId: row.id,
            after: { storeId: store.id, itemId: line.itemId, quantity: line.quantity },
            event: eventOf('stock.received', row, line.quantity),
          },
        );
      }
    },

    /** BR-3: issues stock to a cost object at the cost the valuation engine gives. */
    async issue(cmd: IssueCommand, actor: Actor, tx: Db): Promise<MovementDto> {
      assertMayIssue(
        actor,
        (await ctx.setting(tx, inventorySettingKeys.supervisorCanIssue)) === true,
      );
      const base = cmd.idempotencyKey ?? ctx.newId();
      const repeat = await findIssueByKey(tx, base);
      if (repeat !== undefined) return movementOf(tx, repeat);
      await ctx.assertNoNegativeStock(tx);
      const ownership: Ownership = cmd.ownership ?? 'company';
      const ownerPartyId = cmd.ownerPartyId ?? null;
      assertOwnerMatches(ownership, ownerPartyId);
      const store = await activeStore(tx, cmd.storeId, actor);
      const item = await stockItem(tx, cmd.itemId);
      const date = await ctx.checkDate(
        tx,
        cmd.businessDate,
        actor,
        'inv_issue',
        cmd.backdateReason,
      );
      const object = cmd.costObject;
      if (object.type === 'project') {
        assertKnown(object.id !== null, 'cost_object_required', 'A project is required');
        assertProjectOpen((await projects.getProject(tx, object.id as string)).status);
      }
      if (ownership === 'client') {
        assertClient(await masterData.getParty(tx, ownerPartyId as string));
        assertKnown(
          object.type === 'project',
          'client_material_project',
          'Client material is issued to a project',
        );
      }
      const costCodeId =
        ownership === 'company'
          ? assertCostCodeKnown(cmd.costCodeId ?? item.defaultCostCodeId)
          : null;

      const issueId = ctx.newId();
      const quantity = fmtQty(new D(cmd.quantity));
      await ctx.assertAvailable(
        tx,
        { storeId: store.id, itemId: cmd.itemId, ownership, ownerPartyId },
        quantity,
      );
      let rows: LedgerRow[] = [];
      let value: string | null = null;
      let movementId: string | null = null;
      if (ownership === 'company') {
        const moved = await valuation.valueIssue(
          {
            storeId: store.id,
            itemId: cmd.itemId,
            quantity,
            postingDate: date,
            sourceRef: issueId,
            idempotencyKey: `${base}:val`,
          },
          { userId: actor.userId, requestId: actor.requestId },
          tx,
        );
        movementId = moved.movementId;
        value = sumParts(moved.parts).value;
        for (const [index, part] of moved.parts.entries()) {
          rows.push(
            (
              await ctx.post(tx, {
                storeId: store.id,
                itemId: cmd.itemId,
                ownership,
                ownerPartyId,
                type: 'issue',
                quantity: part.quantity,
                unitCost: part.unitCost,
                value: part.value,
                costObject: object,
                source: { type: 'issue', id: issueId, lineId: part.layerId },
                businessDate: date,
                key: `${base}:${index}`,
                by: actor.userId,
              })
            ).row,
          );
        }
      } else {
        rows = [
          (
            await ctx.post(tx, {
              storeId: store.id,
              itemId: cmd.itemId,
              ownership,
              ownerPartyId,
              type: 'issue',
              quantity,
              costObject: object,
              source: { type: 'issue', id: issueId },
              businessDate: date,
              key: `${base}:0`,
              by: actor.userId,
            })
          ).row,
        ];
      }

      const entry =
        costCodeId === null
          ? null
          : await projects.postCost(
              {
                costObject: object,
                costCodeId,
                amount: value as string,
                status: 'posted',
                sourceModule: 'inventory',
                sourceDocType: 'stock_issue',
                sourceDocId: issueId,
                entryDate: date,
                description: cmd.note ?? 'Stock issued',
                idempotencyKey: `issue:${issueId}`,
                actorUserId: actor.userId,
              },
              tx,
            );
      const issue = await insertIssue(
        tx,
        {
          id: issueId,
          store_id: store.id,
          item_id: cmd.itemId,
          ownership,
          owner_party_id: ownerPartyId,
          quantity,
          value,
          cost_object_type: object.type,
          cost_object_id: object.id,
          cost_code_id: costCodeId,
          valuation_movement_id: movementId,
          cost_entry_id: entry?.id ?? null,
          business_date: date,
          idempotency_key: base,
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'inventory.stock.issue',
        entityType: 'inv_issue',
        entityId: issue.id,
        after: { storeId: store.id, itemId: cmd.itemId, quantity, value, ownership },
        event: eventOf('stock.issued', rows[0] as LedgerRow, quantity),
      });
      return movementOf(tx, issue);
    },

    /** BR-6: gives back part or all of an issue at its original cost and restates the project cost. */
    async returnToStore(cmd: ReturnCommand, actor: Actor, tx: Db): Promise<MovementDto> {
      const base = cmd.idempotencyKey ?? ctx.newId();
      const issue = assertFound(await findIssue(tx, cmd.issueId, true), 'issue');
      const store = await activeStore(tx, issue.store_id, actor);
      assertKnown(
        issue.ownership === 'company',
        'client_issue_return',
        'Client material goes back through a client return',
      );
      const date = await ctx.checkDate(
        tx,
        cmd.businessDate,
        actor,
        'inv_return',
        cmd.backdateReason,
      );
      const kept = assertReturnable(issue.quantity, issue.returned_quantity, cmd.quantity);
      const quantity = fmtQty(new D(cmd.quantity));
      const moved = await valuation.recordReturn(
        {
          issueRef: issue.valuation_movement_id as string,
          quantity,
          postingDate: date,
          sourceRef: issue.id,
          idempotencyKey: `${base}:val`,
        },
        { userId: actor.userId, requestId: actor.requestId },
        tx,
      );
      const { row, repeated } = await ctx.post(tx, {
        storeId: store.id,
        itemId: issue.item_id,
        ownership: 'company',
        ownerPartyId: null,
        type: 'return_in',
        quantity,
        unitCost: moved.unitCost,
        value: moved.value,
        costObject: { type: issue.cost_object_type, id: issue.cost_object_id },
        source: { type: 'issue_return', id: issue.id },
        businessDate: date,
        key: `${base}:0`,
        by: actor.userId,
      });
      if (repeated) return ledgerMovement(issue.id, row);

      const returnedValue = fmtMoney(new D(issue.returned_value).plus(moved.value));
      let costEntryId: string | null = null;
      await projects.reverseCost(
        issue.cost_entry_id as string,
        `Returned to store (${quantity})`,
        tx,
        actor.userId,
      );
      const remaining = remainingIssueCost(issue.value as string, returnedValue);
      if (new D(remaining).greaterThan(0)) {
        costEntryId = (
          await projects.postCost(
            {
              costObject: {
                type: issue.cost_object_type as CostObjectRef['type'],
                id: issue.cost_object_id,
              },
              costCodeId: issue.cost_code_id as string,
              amount: remaining,
              status: 'posted',
              sourceModule: 'inventory',
              sourceDocType: 'stock_issue',
              sourceDocId: issue.id,
              sourceLineId: row.id,
              entryDate: date,
              description: `Stock issue restated after a return (${kept} still issued)`,
              idempotencyKey: `issue-restated:${row.id}`,
              actorUserId: actor.userId,
            },
            tx,
          )
        ).id;
      }
      await recordIssueReturn(tx, issue.id, {
        returnedQuantity: fmtQty(new D(issue.quantity).minus(kept)),
        returnedValue,
        costEntryId,
        by: actor.userId,
        at: clock.now(),
      });
      await record(tx, actor, {
        action: 'inventory.stock.return',
        entityType: 'inv_issue',
        entityId: issue.id,
        after: { quantity, value: moved.value, stillIssued: kept },
        event: eventOf('stock.received', row, quantity),
      });
      return { ...ledgerMovement(issue.id, row), costEntryId };
    },

    /** BR-5: client material comes in by quantity only, for a project. */
    async receiveClientMaterial(cmd: ClientCommand, actor: Actor, tx: Db): Promise<MovementDto> {
      return clientMovement(
        'client_receipt',
        'inventory.stock.client_receipt',
        'stock.received',
        cmd,
        actor,
        tx,
      );
    },

    /** BR-5: client material goes back to the client. */
    async returnClientMaterial(cmd: ClientCommand, actor: Actor, tx: Db): Promise<MovementDto> {
      return clientMovement(
        'client_return',
        'inventory.stock.client_return',
        'stock.issued',
        cmd,
        actor,
        tx,
      );
    },

    /** BR-7, H-21: salvaged material enters company stock; a non-zero value credits the project. */
    async salvage(cmd: SalvageCommand, actor: Actor, tx: Db): Promise<MovementDto> {
      const base = cmd.idempotencyKey ?? ctx.newId();
      const store = await activeStore(tx, cmd.storeId, actor);
      const item = await stockItem(tx, cmd.itemId);
      const date = await ctx.checkDate(
        tx,
        cmd.businessDate,
        actor,
        'inv_salvage',
        cmd.backdateReason,
      );
      const priced = salvageValue(
        String(await ctx.setting(tx, inventorySettingKeys.salvageValueMode)),
        cmd.quantity,
        cmd.unitValue,
      );
      const credited = new D(priced.value).greaterThan(0);
      if (credited)
        assertKnown(
          cmd.projectId !== undefined,
          'project_required',
          'A project is needed to credit salvage value',
        );
      if (cmd.projectId !== undefined) {
        assertProjectOpen((await projects.getProject(tx, cmd.projectId)).status);
      }
      const quantity = fmtQty(new D(cmd.quantity));
      const moved = await valuation.recordReceipt(
        {
          storeId: store.id,
          itemId: cmd.itemId,
          quantity,
          unitCost: priced.unitValue,
          postingDate: date,
          sourceRef: 'salvage',
          idempotencyKey: `${base}:val`,
        },
        { userId: actor.userId, requestId: actor.requestId },
        tx,
      );
      const id = ctx.newId();
      const { row, repeated } = await ctx.post(tx, {
        storeId: store.id,
        itemId: cmd.itemId,
        ownership: 'company',
        ownerPartyId: null,
        type: 'salvage_in',
        quantity,
        unitCost: priced.unitValue,
        value: moved.value,
        costObject: cmd.projectId === undefined ? null : { type: 'project', id: cmd.projectId },
        source: { type: 'salvage', id },
        businessDate: date,
        key: `${base}:0`,
        by: actor.userId,
      });
      if (repeated) return ledgerMovement(row.source_doc_id, row);
      let entryId: string | null = null;
      if (credited) {
        entryId = (
          await projects.postCost(
            {
              costObject: { type: 'project', id: cmd.projectId as string },
              costCodeId: assertCostCodeKnown(cmd.costCodeId ?? item.defaultCostCodeId),
              amount: fmtMoney(new D(priced.value).negated()),
              status: 'posted',
              sourceModule: 'inventory',
              sourceDocType: SALVAGE_DOC_TYPE,
              sourceDocId: id,
              entryDate: date,
              description: cmd.note ?? 'Salvaged material',
              idempotencyKey: `salvage:${id}`,
              actorUserId: actor.userId,
            },
            tx,
          )
        ).id;
      }
      await record(tx, actor, {
        action: 'inventory.stock.salvage',
        entityType: 'inv_ledger',
        entityId: row.id,
        after: { quantity, value: moved.value },
        event: eventOf('stock.received', row, quantity),
      });
      return { ...ledgerMovement(id, row), costEntryId: entryId };
    },

    /** Module interface `getStockOnHand` (spec section 2). */
    async getStockOnHand(
      db: Db,
      storeId: string,
      itemId: string,
      ownership: Ownership,
      ownerPartyId: string | null,
    ): Promise<string> {
      return balanceOf(db, { storeId, itemId, ownership, ownerPartyId });
    },

    /** Module interface `hasIssuesFromGrn` (spec section 2): the guard of procurement BR-8. */
    hasIssuesFromGrn: (db: Db, grnId: string): Promise<boolean> => hasOutflowSince(db, grnId),

    async listStock(db: Db, query: StockQuery, actor: Actor): Promise<PageResult<StockDto>> {
      const scope = scopeFilter(actor, 'project');
      const { rows, total } = await searchStock(db, {
        ...query,
        projectIds: scope.all ? undefined : scope.ids,
      });
      return pageOf(
        rows.map((row) => ({
          storeId: row.store_id,
          itemId: row.item_id,
          ownership: row.ownership as Ownership,
          ownerPartyId: row.owner_party_id,
          quantity: row.quantity,
        })),
        total,
        query,
      );
    },

    /**
     * Module interface `listStockWithValue(filter)` (P1-19 BR-2): every balance, company-owned stock
     * valued by the valuation engine and client-owned stock by quantity only.
     */
    async listStockWithValue(db: Db, filter: StockFilter = {}): Promise<StockValueRowDto[]> {
      const rows = await listBalances(db, filter);
      const result: StockValueRowDto[] = [];
      for (const row of rows) {
        result.push({
          storeId: row.store_id,
          itemId: row.item_id,
          ownership: row.ownership as Ownership,
          ownerPartyId: row.owner_party_id,
          quantity: row.quantity,
          value:
            row.ownership === 'company'
              ? (await valuation.getStockValue(db, row.store_id, row.item_id)).value
              : null,
        });
      }
      return result;
    },

    /** Module interface `listBelowReorder(filter)` (P1-19 BR-2): company stock below its level. */
    async listBelowReorder(db: Db, filter: StockFilter = {}): Promise<BelowReorderDto[]> {
      return (await listBelowReorderRows(db, filter)).map((row) => ({
        storeId: row.store_id,
        itemId: row.item_id,
        level: row.level,
        quantity: fmtQty(new D(row.quantity)),
        shortfall: fmtQty(new D(row.level).minus(row.quantity)),
      }));
    },

    async listLedger(db: Db, query: LedgerQuery, actor: Actor): Promise<PageResult<LedgerDto>> {
      const scope = scopeFilter(actor, 'project');
      const { rows, total } = await searchLedger(db, {
        ...query,
        projectIds: scope.all ? undefined : scope.ids,
      });
      return pageOf(rows.map(ledgerDtoOf), total, query);
    },

    /** BR-5: received, used, returned and balance by item for the client material of a project. */
    async clientMaterial(db: Db, projectId: string): Promise<ClientMaterialDto[]> {
      return (await listClientMaterial(db, projectId)).map((row) => ({
        projectId: row.project_id,
        storeId: row.store_id,
        itemId: row.item_id,
        ownerPartyId: row.owner_party_id,
        received: row.received_qty,
        used: row.used_qty,
        returned: row.returned_qty,
        balance: row.balance_qty,
      }));
    },

    /** BR-12: every balance must equal the signed sum of its ledger. */
    async integrity(db: Db): Promise<IntegrityReport> {
      const { checked, differences } = await integrityRows(db);
      return {
        checked,
        differences: differences.map((row) => ({
          storeId: row.store_id,
          itemId: row.item_id,
          ownership: row.ownership as Ownership,
          ownerPartyId: row.owner_party_id,
          balance: row.balance,
          ledgerSum: row.ledger_sum,
          difference: fmtQty(new D(row.balance).minus(row.ledger_sum)),
        })),
      };
    },
  };

  async function clientMovement(
    type: 'client_receipt' | 'client_return',
    action: string,
    event: 'stock.received' | 'stock.issued',
    cmd: ClientCommand,
    actor: Actor,
    tx: Db,
  ): Promise<MovementDto> {
    const base = cmd.idempotencyKey ?? ctx.newId();
    const store = await activeStore(tx, cmd.storeId, actor);
    await stockItem(tx, cmd.itemId);
    assertClient(await masterData.getParty(tx, cmd.ownerPartyId));
    assertProjectOpen((await projects.getProject(tx, cmd.projectId)).status);
    const date = await ctx.checkDate(
      tx,
      cmd.businessDate,
      actor,
      'inv_client_material',
      cmd.backdateReason,
    );
    const quantity = fmtQty(new D(cmd.quantity));
    const id = ctx.newId();
    const { row, repeated } = await ctx.post(tx, {
      storeId: store.id,
      itemId: cmd.itemId,
      ownership: 'client',
      ownerPartyId: cmd.ownerPartyId,
      type,
      quantity,
      costObject: { type: 'project', id: cmd.projectId },
      source: { type: type, id },
      businessDate: date,
      key: `${base}:0`,
      by: actor.userId,
    });
    if (!repeated) {
      await record(tx, actor, {
        action,
        entityType: 'inv_ledger',
        entityId: row.id,
        after: { storeId: store.id, itemId: cmd.itemId, quantity, ownerPartyId: cmd.ownerPartyId },
        event: eventOf(event, row, quantity),
      });
    }
    return ledgerMovement(row.source_doc_id, row);
  }
}
