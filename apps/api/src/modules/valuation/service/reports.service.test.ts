import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAT_MATERIALS,
  CAT_STEEL,
  createValuationKit,
  ITEM_CEMENT,
  ITEM_SAND,
  ITEM_STEEL,
  STORE_A,
  STORE_B,
  TODAY,
  type ValuationKit,
} from '../test-support.js';

let kit: ValuationKit;
beforeAll(async () => {
  kit = await createValuationKit();
  await kit.activatePolicy({
    scope: 'category',
    categoryId: CAT_STEEL,
    method: 'fifo',
    effectiveFrom: TODAY,
  });
  const receive = (storeId: string, itemId: string, quantity: string, unitCost: string) =>
    kit.tx((tx) =>
      kit.valuation.recordReceipt(
        {
          storeId,
          itemId,
          quantity,
          unitCost,
          postingDate: TODAY,
          sourceRef: 'GRN-1',
          idempotencyKey: kit.key(),
        },
        kit.actor,
        tx,
      ),
    );
  await receive(STORE_A, ITEM_CEMENT, '10', '100');
  await receive(STORE_B, ITEM_CEMENT, '4', '110');
  await receive(STORE_A, ITEM_STEEL, '2', '500');
  await receive(STORE_A, ITEM_SAND, '5', '20');
}, 60_000);
afterAll(() => kit.close());

const report = (filter: Parameters<typeof kit.valuation.getTotalValue>[1]) =>
  kit.valuation.getTotalValue(kit.db, filter);

describe('stock valuation report (BR-13)', () => {
  it('lists every key with its method and adds up the total', async () => {
    const all = await report({});
    expect(all.items).toHaveLength(4);
    expect(all.totalValue).toBe('2540.00');
    expect(all.items.find((i) => i.itemId === ITEM_STEEL)).toMatchObject({
      method: 'fifo',
      quantity: '2.0000',
      value: '1000.00',
      averageCost: '500.0000',
    });
    expect(all.items.find((i) => i.itemId === ITEM_SAND)?.categoryId).toBeNull();
  });

  it('filters by store, item and category including descendants', async () => {
    expect((await report({ storeId: STORE_B })).totalValue).toBe('440.00');
    expect((await report({ itemId: ITEM_CEMENT })).items).toHaveLength(2);
    expect((await report({ categoryId: CAT_STEEL })).totalValue).toBe('1000.00');
    expect((await report({ categoryId: CAT_MATERIALS })).totalValue).toBe('2440.00');
    expect(await report({ storeId: STORE_B, categoryId: CAT_STEEL })).toEqual({
      items: [],
      totalValue: '0.00',
    });
  });

  it('gives the value of one key, or an empty one in the method that applies', async () => {
    expect(await kit.valuation.getStockValue(kit.db, STORE_A, ITEM_CEMENT)).toMatchObject({
      quantity: '10.0000',
      value: '1000.00',
    });
    expect(await kit.valuation.getStockValue(kit.db, STORE_B, ITEM_STEEL)).toEqual({
      storeId: STORE_B,
      itemId: ITEM_STEEL,
      categoryId: CAT_STEEL,
      method: 'fifo',
      quantity: '0.0000',
      value: '0.00',
      averageCost: '0.0000',
    });
    expect((await kit.valuation.getStockValue(kit.db, STORE_B, ITEM_SAND)).categoryId).toBeNull();
  });
});

describe('movement and transition lists', () => {
  it('pages movements newest first and filters them', async () => {
    const page = await kit.valuation.reports.movements(kit.db, { limit: 2, offset: 0 });
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.seq).toBeGreaterThan(page.items[1]?.seq ?? 0);
    expect(page.items[0]).toMatchObject({
      postingDate: TODAY,
      sourceRef: 'GRN-1',
      type: 'receipt',
    });
    const cement = await kit.valuation.reports.movements(kit.db, {
      itemId: ITEM_CEMENT,
      storeId: STORE_B,
      type: 'receipt',
      limit: 10,
      offset: 0,
    });
    expect(cement.items.map((m) => m.value)).toEqual(['440.00']);
    expect(
      (await kit.valuation.reports.movements(kit.db, { type: 'issue', limit: 10, offset: 0 }))
        .total,
    ).toBe(0);
  });

  it('lists transitions', async () => {
    expect(await kit.valuation.reports.transitions(kit.db, { limit: 10, offset: 0 })).toEqual({
      items: [],
      total: 0,
      limit: 10,
      offset: 0,
    });
  });
});
