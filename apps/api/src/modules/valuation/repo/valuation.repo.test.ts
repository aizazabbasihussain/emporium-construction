import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createValuationKit,
  STORE_A,
  STORE_B,
  TODAY,
  uid,
  type ValuationKit,
} from '../test-support.js';
import {
  decidePolicy,
  findMovement,
  findMovementByKey,
  findPolicy,
  getWaState,
  insertConsumption,
  insertLayer,
  insertMovement,
  insertPolicy,
  insertReturnPart,
  insertTransition,
  keyValue,
  listConsumptions,
  listKeys,
  listKeyValues,
  listOpenLayers,
  listPolicies,
  listReturnableParts,
  lockExistingKeys,
  lockKey,
  saveWaState,
  searchMovements,
  searchTransitions,
  supersedeSameStart,
  touchKey,
  updateLayer,
} from './valuation.repo.js';

// Repository functions against PGlite with every migration applied (constitution 10.2).

let kit: ValuationKit;
beforeAll(async () => {
  kit = await createValuationKit();
}, 60_000);
afterAll(() => kit.close());

const ITEM = uid(901);
const at = new Date('2026-10-25T10:00:00Z');
const POLICY_BASE = { scope: 'company', categoryId: null, method: 'fifo', requestedBy: uid(1), at };

describe('policies', () => {
  it('inserts, finds, lists, decides and supersedes', async () => {
    const [a, b] = [uid(910), uid(911)] as [string, string];
    for (const id of [a, b]) {
      await insertPolicy(kit.db, { id, ...POLICY_BASE, effectiveFrom: '2031-01-01' });
    }
    expect(await findPolicy(kit.db, a, true)).toMatchObject({
      status: 'pending_approval',
      method: 'fifo',
    });
    expect(await findPolicy(kit.db, uid(999))).toBeUndefined();
    await decidePolicy(kit.db, a, {
      status: 'active',
      effectiveFrom: '2031-01-01',
      approvedBy: uid(2),
    });
    await supersedeSameStart(kit.db, {
      id: b,
      scope: 'company',
      categoryId: null,
      effectiveFrom: '2031-01-01',
    });
    expect((await findPolicy(kit.db, a))?.status).toBe('superseded');
    expect((await listPolicies(kit.db, 'pending_approval')).map((p) => p.id)).toContain(b);
    expect((await listPolicies(kit.db)).length).toBeGreaterThanOrEqual(3);
  });
});

describe('keys, state and layers', () => {
  it('creates and locks a key once, keeps its dates and lists it', async () => {
    const first = await lockKey(kit.db, STORE_A, ITEM, 'fifo');
    expect(first).toMatchObject({ method: 'fifo', last_posting_date: null });
    const again = await lockKey(kit.db, STORE_A, ITEM, 'weighted_average');
    expect(again.method).toBe('fifo');
    await touchKey(kit.db, STORE_A, ITEM, 'weighted_average', TODAY);
    expect((await listKeys(kit.db)).find((k) => k.item_id === ITEM)).toMatchObject({
      method: 'weighted_average',
      last_posting_date: TODAY,
    });
    await lockExistingKeys(kit.db, [
      { storeId: STORE_B, itemId: ITEM },
      { storeId: STORE_A, itemId: ITEM },
    ]);
  });

  it('saves weighted-average state and values a key under either method', async () => {
    expect(await getWaState(kit.db, STORE_A, ITEM)).toEqual({
      quantity: '0.0000',
      total_value: '0.00',
    });
    await saveWaState(kit.db, STORE_A, ITEM, { quantity: '2', totalValue: '5.50', seq: 3 });
    await insertLayer(kit.db, {
      id: uid(920),
      storeId: STORE_A,
      itemId: ITEM,
      receiptRef: 'GRN-9',
      receivedSeq: 1,
      quantity: '4',
      value: '8.00',
      unitCost: '2',
      at,
    });
    expect(await keyValue(kit.db, STORE_A, ITEM)).toBe('13.50');
    expect(await listKeyValues(kit.db, { storeId: STORE_A, itemId: ITEM })).toEqual([
      expect.objectContaining({ quantity: '6.0000', value: '13.50' }),
    ]);
    expect((await listKeyValues(kit.db, {})).length).toBeGreaterThanOrEqual(1);
    await updateLayer(kit.db, uid(920), '3.0000', '6.00');
    expect(await listOpenLayers(kit.db, STORE_A, ITEM)).toEqual([
      expect.objectContaining({ id: uid(920), remaining_qty: '3.0000', remaining_value: '6.00' }),
    ]);
    await updateLayer(kit.db, uid(920), '0', '0');
    expect(await listOpenLayers(kit.db, STORE_A, ITEM)).toEqual([]);
  });
});

describe('movements, consumptions and returns', () => {
  const movement = (id: string, key: string, type = 'issue') => ({
    id,
    storeId: STORE_A,
    itemId: ITEM,
    type,
    quantity: '2',
    value: '4.00',
    unitCost: '2',
    method: 'fifo',
    postingDate: TODAY,
    sourceRef: 'ref',
    issueMovementId: null,
    idempotencyKey: key,
    by: uid(1),
    at,
  });

  it('stores a movement and finds it by id and by idempotency key', async () => {
    const row = await insertMovement(kit.db, movement(uid(930), 'repo-1'));
    expect(row).toMatchObject({ value: '4.00', posting_date: TODAY, type: 'issue' });
    expect(Number(row.seq)).toBeGreaterThan(0);
    expect((await findMovement(kit.db, uid(930)))?.idempotency_key).toBe('repo-1');
    expect((await findMovementByKey(kit.db, 'repo-1'))?.id).toBe(uid(930));
    expect(await findMovement(kit.db, uid(999))).toBeUndefined();
    expect(await findMovementByKey(kit.db, 'missing')).toBeUndefined();
    await expect(insertMovement(kit.db, movement(uid(931), 'repo-1'))).rejects.toThrow();
  });

  it('records the parts of an issue and what has come back of them', async () => {
    await insertConsumption(kit.db, {
      id: uid(940),
      movementId: uid(930),
      partNo: 1,
      layerId: uid(920),
      layerReceivedSeq: 1,
      quantity: '2',
      unitCost: '2',
      value: '4.00',
    });
    expect(await listConsumptions(kit.db, uid(930))).toEqual([
      expect.objectContaining({
        id: uid(940),
        layer_id: uid(920),
        layer_received_seq: '1',
        value: '4.00',
      }),
    ]);
    await insertMovement(kit.db, {
      ...movement(uid(932), 'repo-2', 'return'),
      issueMovementId: uid(930),
    });
    await insertReturnPart(kit.db, {
      id: uid(950),
      movementId: uid(932),
      consumptionId: uid(940),
      quantity: '0.5',
      value: '1.00',
    });
    expect(await listReturnableParts(kit.db, uid(930))).toEqual([
      expect.objectContaining({ id: uid(940), returned_qty: '0.5000', returned_value: '1.00' }),
    ]);
  });

  it('searches movements with filters and paging', async () => {
    const all = await searchMovements(kit.db, { limit: 10, offset: 0 });
    expect(all.total).toBeGreaterThanOrEqual(2);
    const issues = await searchMovements(kit.db, {
      storeId: STORE_A,
      itemId: ITEM,
      type: 'issue',
      limit: 1,
      offset: 0,
    });
    expect(issues.rows).toHaveLength(1);
    expect(issues.total).toBe(1);
  });
});

describe('transitions', () => {
  it('records one transition per key and policy and lists them', async () => {
    const policyId = uid(910);
    const input = {
      id: uid(960),
      storeId: STORE_A,
      itemId: ITEM,
      fromMethod: 'weighted_average',
      toMethod: 'fifo',
      quantity: '2',
      valueBefore: '5.50',
      valueAfter: '5.50',
      policyId,
      at,
    };
    expect(await insertTransition(kit.db, input)).toMatchObject({
      qty: '2.0000',
      value_after: '5.50',
    });
    await expect(insertTransition(kit.db, { ...input, id: uid(961) })).rejects.toThrow();
    expect(await searchTransitions(kit.db, { limit: 5, offset: 0 })).toMatchObject({ total: 1 });
  });
});
