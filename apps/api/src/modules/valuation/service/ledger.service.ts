import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import {
  assertConserved,
  assertValueHeld,
  D,
  fifoIssue,
  fifoToWa,
  fmtMoney,
  fmtQty,
  fmtRate,
  layersQuantity,
  money,
  newLayer,
  nonNegative,
  planReturn,
  positiveQuantity,
  unitCostOf,
  waIssue,
  waReceive,
  waToFifo,
  ZERO,
  type Dec,
  type IssuePart,
  type Layer,
  type Method,
  type ReturnablePart,
  type WaState,
} from '@emporium/domain/valuation';
import type { ValuationMethod } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import { assertDifferentStores, assertFound, assertIssue } from '../policy/valuation.policy.js';
import {
  findMovement,
  findMovementByKey,
  getWaState,
  insertConsumption,
  insertLayer,
  insertMovement,
  insertReturnPart,
  insertTransition,
  keyValue,
  listKeys,
  listOpenLayers,
  listReturnableParts,
  lockExistingKeys,
  lockKey,
  saveWaState,
  touchKey,
  updateLayer,
  type KeyRow,
  type LayerRow,
  type MovementRow,
  type TransitionRow,
} from '../repo/valuation.repo.js';
import type { Actor, Db, MovementResult, TransferResult, TransitionDto } from '../types.js';
import type { PoliciesService } from './policies.service.js';
import { resultOf } from './results.js';
import { createRecorder } from './support.js';

interface PostingInput {
  postingDate: string;
  sourceRef?: string | null | undefined;
  idempotencyKey: string;
}

export interface ReceiptInput extends PostingInput {
  storeId: string;
  itemId: string;
  quantity: string;
  unitCost: string;
}

export interface IssueInput extends PostingInput {
  storeId: string;
  itemId: string;
  quantity: string;
}

export interface TransferInput extends PostingInput {
  fromStoreId: string;
  toStoreId: string;
  itemId: string;
  quantity: string;
}

export interface ReturnInput extends PostingInput {
  /** The id of the issue movement being given back (`movementId` in the issue result). */
  issueRef: string;
  quantity: string;
}

export interface LedgerService {
  /** BR-4, BR-5: values a receipt and adds it to the key. */
  recordReceipt(input: ReceiptInput, actor: Actor, tx: Db): Promise<MovementResult>;
  /** BR-4, BR-5, BR-7: values an issue by the method in force and takes it from the key. */
  valueIssue(input: IssueInput, actor: Actor, tx: Db): Promise<MovementResult>;
  /** BR-8: an issue at the source and a receipt at the destination at the same total value. */
  recordTransfer(input: TransferInput, actor: Actor, tx: Db): Promise<TransferResult>;
  /** BR-9: gives back part or all of an issue at its original cost. */
  recordReturn(input: ReturnInput, actor: Actor, tx: Db): Promise<MovementResult>;
  /** BR-11: converts every key whose method differs from the policy in force today. */
  runTransitions(actor: Actor, tx: Db): Promise<TransitionDto[]>;
}

const toLayer = (row: LayerRow): Layer => ({
  id: row.id,
  receivedSeq: Number(row.received_seq),
  remainingQty: new D(row.remaining_qty),
  remainingValue: new D(row.remaining_value),
  unitCost: new D(row.unit_cost),
});

const toWa = (row: { quantity: string; total_value: string }): WaState => ({
  quantity: new D(row.quantity),
  totalValue: new D(row.total_value),
});

export const toTransitionDto = (row: TransitionRow): TransitionDto => ({
  id: row.id,
  storeId: row.store_id,
  itemId: row.item_id,
  fromMethod: row.from_method as ValuationMethod,
  toMethod: row.to_method as ValuationMethod,
  quantity: row.qty,
  valueBefore: row.value_before,
  valueAfter: row.value_after,
  policyId: row.policy_id,
  completedAt: row.completed_at.toISOString(),
});

/** A key never goes back to an earlier policy: its method is resolved at the later date. */
const laterOf = (keyDate: string | null, date: string): string =>
  keyDate !== null && keyDate > date ? keyDate : date;

const isWa = (method: Method) => method === 'weighted_average';

export function createLedgerService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  policies: Pick<PoliciesService, 'resolvePolicy'>;
}): LedgerService {
  const { platform, clock, newId, policies } = deps;
  const record = createRecorder(platform);

  async function recordMovement(
    tx: Db,
    actor: Actor,
    movement: Parameters<typeof insertMovement>[1],
  ): Promise<MovementRow> {
    const row = await insertMovement(tx, movement);
    await record(tx, actor, {
      action: `valuation.${movement.type}`,
      entityType: 'val_movement',
      entityId: movement.id,
      after: {
        type: movement.type,
        storeId: movement.storeId,
        itemId: movement.itemId,
        quantity: movement.quantity,
        value: movement.value,
        method: movement.method,
        postingDate: movement.postingDate,
      },
      event: {
        type: 'valuation.movement.recorded',
        payload: {
          movementId: movement.id,
          type: movement.type,
          storeId: movement.storeId,
          itemId: movement.itemId,
          quantity: movement.quantity,
          value: movement.value,
        },
      },
    });
    return row;
  }

  /** Adds quantity and value to a key in its method: into the average, or as a layer. */
  async function restock(
    tx: Db,
    key: { storeId: string; itemId: string; method: Method; receiptRef: string | null },
    stock: { seq: number; quantity: Dec; value: Dec; unitCost: Dec },
  ): Promise<void> {
    if (isWa(key.method)) {
      const state = waReceive(
        toWa(await getWaState(tx, key.storeId, key.itemId)),
        stock.quantity,
        stock.value,
      );
      await saveWaState(tx, key.storeId, key.itemId, {
        quantity: fmtQty(state.quantity),
        totalValue: fmtMoney(state.totalValue),
        seq: stock.seq,
      });
      return;
    }
    const layer = newLayer({
      id: newId(),
      receivedSeq: stock.seq,
      quantity: stock.quantity,
      value: stock.value,
      unitCost: stock.unitCost,
    });
    await insertLayer(tx, {
      id: layer.id,
      storeId: key.storeId,
      itemId: key.itemId,
      receiptRef: key.receiptRef,
      receivedSeq: layer.receivedSeq,
      quantity: fmtQty(stock.quantity),
      value: fmtMoney(stock.value),
      unitCost: fmtRate(stock.unitCost),
      at: clock.now(),
    });
  }

  /** Moves a key to the method of `to`, holding its total value exactly (BR-10). */
  async function convert(
    tx: Db,
    key: KeyRow,
    to: { id: string; method: Method },
    date: string,
    actor: Actor,
  ): Promise<TransitionRow> {
    const from = key.method as Method;
    const state = toWa(await getWaState(tx, key.store_id, key.item_id));
    const layers = (await listOpenLayers(tx, key.store_id, key.item_id)).map(toLayer);
    const before = new D(await keyValue(tx, key.store_id, key.item_id));
    const quantity = isWa(from) ? state.quantity : layersQuantity(layers);
    const movement = await recordMovement(tx, actor, {
      id: newId(),
      storeId: key.store_id,
      itemId: key.item_id,
      type: 'transition',
      quantity: fmtQty(quantity),
      value: fmtMoney(before),
      unitCost: quantity.isZero() ? '0.0000' : fmtRate(unitCostOf(before, quantity)),
      method: to.method,
      postingDate: date,
      sourceRef: null,
      issueMovementId: null,
      idempotencyKey: `transition:${key.store_id}:${key.item_id}:${to.id}`,
      by: actor.userId,
      at: clock.now(),
    });
    const seq = Number(movement.seq);
    if (isWa(from)) {
      for (const layer of waToFifo({ state, layerId: newId(), transitionSeq: seq })) {
        await insertLayer(tx, {
          id: layer.id,
          storeId: key.store_id,
          itemId: key.item_id,
          receiptRef: 'transition',
          receivedSeq: layer.receivedSeq,
          quantity: fmtQty(layer.remainingQty),
          value: fmtMoney(layer.remainingValue),
          unitCost: fmtRate(layer.unitCost),
          at: clock.now(),
        });
      }
      await saveWaState(tx, key.store_id, key.item_id, { quantity: '0', totalValue: '0', seq });
    } else {
      const merged = fifoToWa(layers);
      for (const layer of layers) await updateLayer(tx, layer.id, '0', '0');
      await saveWaState(tx, key.store_id, key.item_id, {
        quantity: fmtQty(merged.quantity),
        totalValue: fmtMoney(merged.totalValue),
        seq,
      });
    }
    const after = new D(await keyValue(tx, key.store_id, key.item_id));
    assertValueHeld(before, after);
    const row = await insertTransition(tx, {
      id: newId(),
      storeId: key.store_id,
      itemId: key.item_id,
      fromMethod: from,
      toMethod: to.method,
      quantity: fmtQty(quantity),
      valueBefore: fmtMoney(before),
      valueAfter: fmtMoney(after),
      policyId: to.id,
      at: clock.now(),
    });
    await touchKey(tx, key.store_id, key.item_id, to.method, date);
    await record(tx, actor, {
      action: 'valuation.transition',
      entityType: 'val_transition',
      entityId: row.id,
      after: toTransitionDto(row),
      event: { type: 'valuation.transition.completed', payload: toTransitionDto(row) },
    });
    return row;
  }

  /** Converts the key when it is not yet kept in the method of the policy in force (BR-11). */
  async function align(
    tx: Db,
    key: KeyRow,
    policy: { id: string; method: Method },
    date: string,
    actor: Actor,
  ): Promise<void> {
    if (key.method === policy.method) return;
    await convert(tx, key, policy, date, actor);
  }

  /** Locks the key and brings it to the method in force on the posting date (BR-1, BR-11). */
  async function prepare(
    tx: Db,
    key: { storeId: string; itemId: string },
    postingDate: string,
    actor: Actor,
  ): Promise<Method> {
    BusinessDate.parse(postingDate);
    const first = await policies.resolvePolicy(tx, key.itemId, postingDate);
    const row = await lockKey(tx, key.storeId, key.itemId, first.method);
    const date = laterOf(row.last_posting_date, postingDate);
    const policy =
      date === postingDate ? first : await policies.resolvePolicy(tx, key.itemId, date);
    await align(tx, row, policy, date, actor);
    await touchKey(tx, key.storeId, key.itemId, policy.method, date);
    return policy.method;
  }

  async function receive(
    tx: Db,
    actor: Actor,
    input: {
      storeId: string;
      itemId: string;
      type: 'receipt' | 'transfer_in';
      quantity: Dec;
      value: Dec;
      unitCost: Dec;
      method: Method;
    } & PostingInput,
  ): Promise<MovementResult> {
    const before = new D(await keyValue(tx, input.storeId, input.itemId));
    const movement = await recordMovement(tx, actor, {
      id: newId(),
      storeId: input.storeId,
      itemId: input.itemId,
      type: input.type,
      quantity: fmtQty(input.quantity),
      value: fmtMoney(input.value),
      unitCost: fmtRate(input.unitCost),
      method: input.method,
      postingDate: input.postingDate,
      sourceRef: input.sourceRef ?? null,
      issueMovementId: null,
      idempotencyKey: input.idempotencyKey,
      by: actor.userId,
      at: clock.now(),
    });
    await restock(
      tx,
      {
        storeId: input.storeId,
        itemId: input.itemId,
        method: input.method,
        receiptRef: input.sourceRef ?? null,
      },
      { seq: Number(movement.seq), ...input },
    );
    const after = new D(await keyValue(tx, input.storeId, input.itemId));
    assertConserved({ before, receipts: input.value, issues: ZERO, after });
    return resultOf(tx, movement);
  }

  async function issue(
    tx: Db,
    actor: Actor,
    input: {
      storeId: string;
      itemId: string;
      type: 'issue' | 'transfer_out';
      quantity: Dec;
      method: Method;
    } & PostingInput,
  ): Promise<MovementResult> {
    const before = new D(await keyValue(tx, input.storeId, input.itemId));
    let value: Dec;
    let parts: IssuePart[];
    let state: WaState | undefined;
    let touched: Layer[] = [];
    if (isWa(input.method)) {
      const result = waIssue(
        toWa(await getWaState(tx, input.storeId, input.itemId)),
        input.quantity,
      );
      value = result.value;
      state = result.state;
      parts = [
        {
          layerId: null,
          layerReceivedSeq: null,
          quantity: input.quantity,
          unitCost: unitCostOf(value, input.quantity),
          value,
        },
      ];
    } else {
      const layers = (await listOpenLayers(tx, input.storeId, input.itemId)).map(toLayer);
      const result = fifoIssue(layers, input.quantity);
      value = result.value;
      parts = result.parts;
      touched = result.layers;
    }
    const movement = await recordMovement(tx, actor, {
      id: newId(),
      storeId: input.storeId,
      itemId: input.itemId,
      type: input.type,
      quantity: fmtQty(input.quantity),
      value: fmtMoney(value),
      unitCost: fmtRate(unitCostOf(value, input.quantity)),
      method: input.method,
      postingDate: input.postingDate,
      sourceRef: input.sourceRef ?? null,
      issueMovementId: null,
      idempotencyKey: input.idempotencyKey,
      by: actor.userId,
      at: clock.now(),
    });
    for (const [index, part] of parts.entries()) {
      await insertConsumption(tx, {
        id: newId(),
        movementId: movement.id,
        partNo: index + 1,
        layerId: part.layerId,
        layerReceivedSeq: part.layerReceivedSeq,
        quantity: fmtQty(part.quantity),
        unitCost: fmtRate(part.unitCost),
        value: fmtMoney(part.value),
      });
    }
    for (const layer of touched) {
      await updateLayer(tx, layer.id, fmtQty(layer.remainingQty), fmtMoney(layer.remainingValue));
    }
    if (state) {
      await saveWaState(tx, input.storeId, input.itemId, {
        quantity: fmtQty(state.quantity),
        totalValue: fmtMoney(state.totalValue),
        seq: Number(movement.seq),
      });
    }
    const after = new D(await keyValue(tx, input.storeId, input.itemId));
    assertConserved({ before, receipts: ZERO, issues: value, after });
    return resultOf(tx, movement);
  }

  return {
    async recordReceipt(input, actor, tx) {
      const replay = await findMovementByKey(tx, input.idempotencyKey);
      if (replay) return resultOf(tx, replay);
      const quantity = positiveQuantity(input.quantity);
      const unitCost = nonNegative(input.unitCost, 4, 'Unit cost');
      const method = await prepare(tx, input, input.postingDate, actor);
      return receive(tx, actor, {
        ...input,
        type: 'receipt',
        quantity,
        unitCost,
        value: money(quantity.times(unitCost)),
        method,
      });
    },

    async valueIssue(input, actor, tx) {
      const replay = await findMovementByKey(tx, input.idempotencyKey);
      if (replay) return resultOf(tx, replay);
      const quantity = positiveQuantity(input.quantity);
      const method = await prepare(tx, input, input.postingDate, actor);
      return issue(tx, actor, { ...input, type: 'issue', quantity, method });
    },

    async recordTransfer(input, actor, tx) {
      const replay = await findMovementByKey(tx, `${input.idempotencyKey}:out`);
      if (replay) {
        const received = assertFound(
          await findMovementByKey(tx, `${input.idempotencyKey}:in`),
          'movement',
        );
        return { out: await resultOf(tx, replay), in: await resultOf(tx, received) };
      }
      assertDifferentStores(input.fromStoreId, input.toStoreId);
      const quantity = positiveQuantity(input.quantity);
      const source = { storeId: input.fromStoreId, itemId: input.itemId };
      const destination = { storeId: input.toStoreId, itemId: input.itemId };
      await lockExistingKeys(tx, [source, destination]);
      const out = await issue(tx, actor, {
        ...source,
        type: 'transfer_out',
        quantity,
        method: await prepare(tx, source, input.postingDate, actor),
        postingDate: input.postingDate,
        sourceRef: input.sourceRef,
        idempotencyKey: `${input.idempotencyKey}:out`,
      });
      const value = new D(out.value);
      const received = await receive(tx, actor, {
        ...destination,
        type: 'transfer_in',
        quantity,
        value,
        unitCost: unitCostOf(value, quantity),
        method: await prepare(tx, destination, input.postingDate, actor),
        postingDate: input.postingDate,
        sourceRef: input.sourceRef,
        idempotencyKey: `${input.idempotencyKey}:in`,
      });
      return { out, in: received };
    },

    async recordReturn(input, actor, tx) {
      const replay = await findMovementByKey(tx, input.idempotencyKey);
      if (replay) return resultOf(tx, replay);
      const issueRow = assertFound(await findMovement(tx, input.issueRef), 'issue');
      assertIssue(issueRow);
      const quantity = positiveQuantity(input.quantity);
      const key = { storeId: issueRow.store_id, itemId: issueRow.item_id };
      const method = await prepare(tx, key, input.postingDate, actor);
      const parts: ReturnablePart[] = (await listReturnableParts(tx, issueRow.id)).map((part) => ({
        consumptionId: part.id,
        layerReceivedSeq: part.layer_received_seq === null ? null : Number(part.layer_received_seq),
        quantity: new D(part.quantity),
        unitCost: new D(part.unit_cost),
        value: new D(part.value),
        returnedQty: new D(part.returned_qty),
        returnedValue: new D(part.returned_value),
      }));
      const allocations = planReturn(parts, quantity);
      const value = allocations.reduce((sum, a) => sum.plus(a.value), ZERO);
      const before = new D(await keyValue(tx, key.storeId, key.itemId));
      const movement = await recordMovement(tx, actor, {
        id: newId(),
        ...key,
        type: 'return',
        quantity: fmtQty(quantity),
        value: fmtMoney(value),
        unitCost: fmtRate(unitCostOf(value, quantity)),
        method,
        postingDate: input.postingDate,
        sourceRef: input.sourceRef ?? null,
        issueMovementId: issueRow.id,
        idempotencyKey: input.idempotencyKey,
        by: actor.userId,
        at: clock.now(),
      });
      for (const allocation of allocations) {
        await insertReturnPart(tx, {
          id: newId(),
          movementId: movement.id,
          consumptionId: allocation.consumptionId,
          quantity: fmtQty(allocation.quantity),
          value: fmtMoney(allocation.value),
        });
        // FIFO puts the stock back where it came from; the average takes it in at its cost.
        await restock(
          tx,
          { ...key, method, receiptRef: input.sourceRef ?? null },
          {
            seq: allocation.layerReceivedSeq ?? Number(issueRow.seq),
            quantity: allocation.quantity,
            value: allocation.value,
            unitCost: allocation.unitCost,
          },
        );
      }
      const after = new D(await keyValue(tx, key.storeId, key.itemId));
      assertConserved({ before, receipts: value, issues: ZERO, after });
      return resultOf(tx, movement);
    },

    async runTransitions(actor, tx) {
      const today = BusinessDate.today(clock).toString();
      const done: TransitionDto[] = [];
      for (const listed of await listKeys(tx)) {
        const key = await lockKey(tx, listed.store_id, listed.item_id, listed.method);
        const date = laterOf(key.last_posting_date, today);
        const policy = await policies.resolvePolicy(tx, key.item_id, date);
        if (key.method !== policy.method) {
          done.push(toTransitionDto(await convert(tx, key, policy, date, actor)));
        }
      }
      return done;
    },
  };
}
