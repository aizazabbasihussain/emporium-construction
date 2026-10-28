import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  createInventoryKit,
  eventCount,
  MISSING,
  uid,
  type InventoryKit,
} from '../test-support.js';

let kit: InventoryKit;
let projectId: string;

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const svc = () => kit.inventory.service;
const run = <T>(fn: (tx: InventoryKit['db']) => Promise<T>) => kit.db.transaction(fn);

const newTransfer = (
  from: string,
  to: string,
  lines: {
    itemId: string;
    quantity: string;
    ownership?: 'company' | 'client';
    ownerPartyId?: string;
    projectId?: string;
  }[],
) =>
  run((t) =>
    svc().transfers.create(
      { fromStoreId: from, toStoreId: to, businessDate: '2026-10-25', lines },
      kit.actor,
      t,
    ),
  );

beforeAll(async () => {
  kit = await createInventoryKit();
  projectId = (await kit.project()).id;
}, 120_000);
afterAll(() => kit.close());

describe('transfers (BR-4, T-5)', () => {
  it('holds stock in transit, carries the cost and ends with the stock at the destination', async () => {
    const a = await kit.store();
    const b = await kit.store();
    const item = await kit.item();
    await kit.receive(a, [{ itemId: item, quantity: '10', unitCost: '100' }]);
    const draft = await newTransfer(a, b, [{ itemId: item, quantity: '4' }]);
    expect(draft).toMatchObject({ status: 'draft' });
    expect((draft as { number: string }).number).toMatch(/^STR-2026-/);
    expect(await kit.stock(a, item)).toBe('10.0000');
    const sent = await run((t) => svc().transfers.send(draft.id, draft.version, kit.actor, t));
    expect(sent.status).toBe('in_transit');
    expect(await kit.stock(a, item)).toBe('6.0000');
    expect(await kit.stock(b, item)).toBe('0.0000');
    const received = await run((t) =>
      svc().transfers.receive(draft.id, sent.version, kit.actor, t),
    );
    expect(received.status).toBe('received');
    expect(await kit.stock(b, item)).toBe('4.0000');
    const value = await kit.valuation.getStockValue(kit.db, b, item);
    expect(value).toMatchObject({ quantity: '4.0000', value: '400.00' });
    const ledger = await svc().stock.listLedger(
      kit.db,
      { storeId: b, limit: 10, offset: 0 },
      kit.actor,
    );
    expect(ledger.items.find((row) => row.movementType === 'transfer_in')).toMatchObject({
      value: '400.00',
    });
    expect((await svc().transfers.get(kit.db, draft.id)).lines).toHaveLength(1);
    expect(
      (await svc().transfers.list(kit.db, { status: 'received', limit: 50, offset: 0 })).total,
    ).toBeGreaterThan(0);
  });

  it('refuses a send of more than the balance and leaves the draft', async () => {
    const a = await kit.store();
    const b = await kit.store();
    const item = await kit.item();
    await kit.receive(a, [{ itemId: item, quantity: '2', unitCost: '10' }]);
    const draft = await newTransfer(a, b, [{ itemId: item, quantity: '3' }]);
    expect(
      await codeOf(run((t) => svc().transfers.send(draft.id, draft.version, kit.actor, t))),
    ).toBe('insufficient_stock');
    expect((await svc().transfers.get(kit.db, draft.id)).status).toBe('draft');
  });

  it('cancels a draft and puts an in-transit transfer back at the source', async () => {
    const a = await kit.store();
    const b = await kit.store();
    const item = await kit.item();
    await kit.receive(a, [{ itemId: item, quantity: '10', unitCost: '10' }]);
    const draft = await newTransfer(a, b, [{ itemId: item, quantity: '4' }]);
    const dropped = await run((t) => svc().transfers.cancel(draft.id, draft.version, kit.actor, t));
    expect(dropped.status).toBe('cancelled');
    expect(await kit.stock(a, item)).toBe('10.0000');
    const second = await newTransfer(a, b, [{ itemId: item, quantity: '4' }]);
    const sent = await run((t) => svc().transfers.send(second.id, second.version, kit.actor, t));
    expect(await kit.stock(a, item)).toBe('6.0000');
    await run((t) => svc().transfers.cancel(second.id, sent.version, kit.actor, t));
    expect(await kit.stock(a, item)).toBe('10.0000');
    expect(await kit.stock(b, item)).toBe('0.0000');
    expect(
      await codeOf(run((t) => svc().transfers.receive(second.id, sent.version + 1, kit.actor, t))),
    ).toBe('transfer_transition');
  });

  it('checks versions, stores, items and owners', async () => {
    const a = await kit.store();
    const b = await kit.store();
    const item = await kit.item();
    const draft = await newTransfer(a, b, [{ itemId: item, quantity: '1' }]);
    expect(await codeOf(run((t) => svc().transfers.send(draft.id, 99, kit.actor, t)))).toBe(
      'version_conflict',
    );
    expect(await codeOf(run((t) => svc().transfers.send(MISSING, 1, kit.actor, t)))).toBe(
      'transfer_not_found',
    );
    expect(await codeOf(newTransfer(a, a, [{ itemId: item, quantity: '1' }]))).toBe('same_store');
    expect(await codeOf(newTransfer(a, MISSING, [{ itemId: item, quantity: '1' }]))).toBe(
      'store_not_found',
    );
    expect(await codeOf(newTransfer(a, b, [{ itemId: MISSING, quantity: '1' }]))).toBe(
      'item_not_found',
    );
    expect(
      await codeOf(newTransfer(a, b, [{ itemId: item, quantity: '1', ownership: 'client' }])),
    ).toBe('owner_required');
    expect(
      await codeOf(
        newTransfer(a, b, [
          { itemId: item, quantity: '1', ownership: 'client', ownerPartyId: uid(5) },
        ]),
      ),
    ).toBe('client_not_found');
    await kit.db.query('update inv_stores set active = false where id = $1', [b]);
    expect(await codeOf(newTransfer(a, b, [{ itemId: item, quantity: '1' }]))).toBe(
      'store_inactive',
    );
    expect(await codeOf(svc().transfers.get(kit.db, MISSING))).toBe('transfer_not_found');
    expect(await codeOf(svc().counts.get(kit.db, MISSING))).toBe('count_not_found');
  });

  it('puts client stock back at the source when an in-transit transfer is cancelled', async () => {
    const a = await kit.store();
    const b = await kit.store();
    const item = await kit.item();
    await run((t) =>
      kit.inventory.receiveClientMaterial(
        {
          storeId: a,
          itemId: item,
          quantity: '9',
          ownerPartyId: kit.clientParty,
          projectId,
          businessDate: '2026-10-25',
        },
        kit.actor,
        t,
      ),
    );
    const draft = await newTransfer(a, b, [
      {
        itemId: item,
        quantity: '5',
        ownership: 'client',
        ownerPartyId: kit.clientParty,
        projectId,
      },
    ]);
    const sent = await run((t) => svc().transfers.send(draft.id, draft.version, kit.actor, t));
    await run((t) => svc().transfers.cancel(draft.id, sent.version, kit.actor, t));
    expect(await kit.inventory.getStockOnHand(kit.db, a, item, 'client', kit.clientParty)).toBe(
      '9.0000',
    );
  });

  it('keeps ownership and owner when client stock moves between stores', async () => {
    const a = await kit.store();
    const b = await kit.store();
    const item = await kit.item();
    await run((t) =>
      kit.inventory.receiveClientMaterial(
        {
          storeId: a,
          itemId: item,
          quantity: '9',
          ownerPartyId: kit.clientParty,
          projectId,
          businessDate: '2026-10-25',
        },
        kit.actor,
        t,
      ),
    );
    const draft = await newTransfer(a, b, [
      {
        itemId: item,
        quantity: '5',
        ownership: 'client',
        ownerPartyId: kit.clientParty,
        projectId,
      },
    ]);
    const sent = await run((t) => svc().transfers.send(draft.id, draft.version, kit.actor, t));
    await run((t) => svc().transfers.receive(draft.id, sent.version, kit.actor, t));
    expect(await kit.inventory.getStockOnHand(kit.db, a, item, 'client', kit.clientParty)).toBe(
      '4.0000',
    );
    expect(await kit.inventory.getStockOnHand(kit.db, b, item, 'client', kit.clientParty)).toBe(
      '5.0000',
    );
    const rows = await svc().stock.clientMaterial(kit.db, projectId);
    expect(rows.find((row) => row.storeId === b)).toMatchObject({ balance: '5.0000' });
  });
});

describe('counts and adjustments (BR-8, T-7)', () => {
  const countOf = (
    storeId: string,
    lines: { itemId: string; countedQty: string; ownership?: 'client'; ownerPartyId?: string }[],
  ) => run((t) => svc().counts.create({ storeId, countedOn: '2026-10-25', lines }, kit.actor, t));

  it('is refused until the stock loss cost code is set', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '10' }]);
    const count = await countOf(store, [{ itemId: item, countedQty: '8' }]);
    expect(count.lines[0]).toMatchObject({ systemQty: '10.0000', countedQty: '8.0000' });
    expect(
      await codeOf(run((t) => svc().counts.submit(count.id, count.version, kit.actor, t))),
    ).toBe('stock_loss_cost_code_missing');
  });

  it('posts adjustments and the loss only after approval', async () => {
    await kit.setting('inventory.stock_loss_cost_code', kit.codes['100'] as string);
    const store = await kit.store();
    const lost = await kit.item();
    const found = await kit.item();
    const same = await kit.item();
    await kit.receive(store, [
      { itemId: lost, quantity: '10', unitCost: '50' },
      { itemId: found, quantity: '10', unitCost: '20' },
      { itemId: same, quantity: '10', unitCost: '5' },
    ]);
    await run((t) =>
      kit.inventory.receiveClientMaterial(
        {
          storeId: store,
          itemId: lost,
          quantity: '6',
          ownerPartyId: kit.clientParty,
          projectId,
          businessDate: '2026-10-25',
        },
        kit.actor,
        t,
      ),
    );
    const count = await countOf(store, [
      { itemId: lost, countedQty: '7' },
      { itemId: found, countedQty: '12' },
      { itemId: same, countedQty: '10' },
      { itemId: lost, countedQty: '4', ownership: 'client', ownerPartyId: kit.clientParty },
    ]);
    const submitted = await run((t) => svc().counts.submit(count.id, count.version, kit.actor, t));
    expect(submitted.status).toBe('counted');
    expect(await kit.stock(store, lost)).toBe('10.0000');
    await kit.decide('stock_adjustment', count.id, 'approve');
    expect((await svc().counts.get(kit.db, count.id)).status).toBe('approved');
    expect(await kit.stock(store, lost)).toBe('7.0000');
    expect(await kit.stock(store, found)).toBe('12.0000');
    expect(await kit.stock(store, same)).toBe('10.0000');
    expect(await kit.inventory.getStockOnHand(kit.db, store, lost, 'client', kit.clientParty)).toBe(
      '4.0000',
    );
    const overhead = await kit.projects.costing.listEntries(
      kit.db,
      { type: 'overhead', id: null },
      { limit: 50, offset: 0 },
    );
    expect(overhead.items.at(-1)).toMatchObject({
      status: 'posted',
      amount: '150.00',
      sourceDocType: 'stock_adjustment',
    });
    expect(await eventCount(kit.db, 'stock.adjusted')).toBeGreaterThanOrEqual(3);
    expect(await auditCount(kit.db, 'inventory.count.approve')).toBe(1);
    expect(
      (await svc().counts.list(kit.db, { status: 'approved', limit: 10, offset: 0 })).total,
    ).toBeGreaterThan(0);
    expect((await svc().stock.integrity(kit.db)).differences).toEqual([]);
  });

  it('reopens a count that is rejected and cancels a draft', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '5' }]);
    const count = await countOf(store, [{ itemId: item, countedQty: '9' }]);
    const submitted = await run((t) => svc().counts.submit(count.id, count.version, kit.actor, t));
    await kit.decide('stock_adjustment', count.id, 'reject');
    const reopened = await svc().counts.get(kit.db, count.id);
    expect(reopened.status).toBe('draft');
    expect(reopened.version).toBeGreaterThan(submitted.version);
    expect(await kit.stock(store, item)).toBe('10.0000');
    const dropped = await run((t) => svc().counts.cancel(count.id, reopened.version, kit.actor, t));
    expect(dropped.status).toBe('cancelled');
    await run((t) => svc().counts.onApprovalOutcome('approved', { docId: count.id }, t));
    expect(await kit.stock(store, item)).toBe('10.0000');
    expect(await codeOf(run((t) => svc().counts.submit(MISSING, 1, kit.actor, t)))).toBe(
      'count_not_found',
    );
    expect(await codeOf(run((t) => svc().counts.cancel(MISSING, 1, kit.actor, t)))).toBe(
      'count_not_found',
    );
    expect(await codeOf(run((t) => svc().counts.cancel(count.id, 1, kit.actor, t)))).toBe(
      'version_conflict',
    );
    expect(await codeOf(run((t) => svc().counts.submit(count.id, 1, kit.actor, t)))).toBe(
      'version_conflict',
    );
  });

  it('refuses unknown references on a count sheet', async () => {
    const store = await kit.store();
    const item = await kit.item();
    expect(await codeOf(countOf(MISSING, [{ itemId: item, countedQty: '1' }]))).toBe(
      'store_not_found',
    );
    expect(await codeOf(countOf(store, [{ itemId: MISSING, countedQty: '1' }]))).toBe(
      'item_not_found',
    );
    expect(
      await codeOf(countOf(store, [{ itemId: item, countedQty: '1', ownership: 'client' }])),
    ).toBe('owner_required');
    expect(
      await codeOf(
        countOf(store, [
          { itemId: item, countedQty: '1', ownership: 'client', ownerPartyId: uid(5) },
        ]),
      ),
    ).toBe('client_not_found');
    await kit.db.query('update inv_stores set active = false where id = $1', [store]);
    expect(await codeOf(countOf(store, [{ itemId: item, countedQty: '1' }]))).toBe(
      'store_inactive',
    );
  });
});

describe('stores and reorder alerts (BR-10, T-8)', () => {
  it('creates stores and refuses duplicates and a project on a warehouse', async () => {
    const site = await run((t) =>
      svc().stores.create(
        { code: 'SITE-A', name: 'Site A', kind: 'site', projectId, custodianUserId: uid(5) },
        kit.actor,
        t,
      ),
    );
    expect(site).toMatchObject({ code: 'SITE-A', projectId, kind: 'site' });
    expect(await svc().stores.get(kit.db, site.id, kit.actor)).toEqual(site);
    expect(
      await codeOf(
        run((t) => svc().stores.create({ code: 'SITE-A', name: 'x', kind: 'site' }, kit.actor, t)),
      ),
    ).toBe('code_taken');
    expect(
      await codeOf(
        run((t) =>
          svc().stores.create(
            { code: 'W-1', name: 'x', kind: 'warehouse', projectId },
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('warehouse_has_project');
    expect(
      await codeOf(
        run((t) => svc().stores.create({ code: ' ', name: 'x', kind: 'site' }, kit.actor, t)),
      ),
    ).toBe('code_required');
    expect(await codeOf(svc().stores.get(kit.db, MISSING, kit.actor))).toBe('store_not_found');
    const listed = await svc().stores.list(
      kit.db,
      { active: true, limit: 50, offset: 0 },
      kit.actor,
    );
    expect(listed.items.some((s) => s.id === site.id)).toBe(true);
    const supervisor = kit.actorFor(uid(6), [{ type: 'project', id: projectId }]);
    const own = await svc().stores.list(kit.db, { limit: 50, offset: 0 }, supervisor);
    expect(own.items.map((s) => s.projectId)).toEqual([projectId]);
  });

  it('alerts once per crossing below the level', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '5' }]);
    await run((t) =>
      svc().stores.setReorderLevel({ storeId: store, itemId: item, level: '5' }, kit.actor, t),
    );
    await run((t) =>
      svc().stores.setReorderLevel({ storeId: store, itemId: item, level: '5' }, kit.actor, t),
    );
    const before = await kit.notificationCount('inventory.reorder.low');
    await kit.issue({ storeId: store, itemId: item, quantity: '4' }, projectId);
    expect(await kit.notificationCount('inventory.reorder.low')).toBe(before);
    await kit.issue({ storeId: store, itemId: item, quantity: '2' }, projectId);
    const first = await kit.notificationCount('inventory.reorder.low');
    expect(first).toBeGreaterThan(before);
    await kit.issue({ storeId: store, itemId: item, quantity: '1' }, projectId);
    expect(await kit.notificationCount('inventory.reorder.low')).toBe(first);
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '5' }]);
    await kit.issue({ storeId: store, itemId: item, quantity: '9' }, projectId);
    expect(await kit.notificationCount('inventory.reorder.low')).toBeGreaterThan(first);
  });

  it('refuses a reorder level for an unknown store or item', async () => {
    const store = await kit.store();
    const item = await kit.item();
    expect(
      await codeOf(
        run((t) =>
          svc().stores.setReorderLevel(
            { storeId: MISSING, itemId: item, level: '1' },
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('store_not_found');
    expect(
      await codeOf(
        run((t) =>
          svc().stores.setReorderLevel(
            { storeId: store, itemId: MISSING, level: '1' },
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('item_not_found');
  });
});

describe('concurrency (BR-11, T-9, AC-3)', () => {
  it('lets exactly six of ten parallel issues of 5 units take 30', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '30', unitCost: '10' }]);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        kit.issue({ storeId: store, itemId: item, quantity: '5' }, projectId),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(4);
    expect(refused.every((r) => (r.reason as { code: string }).code === 'insufficient_stock')).toBe(
      true,
    );
    expect(await kit.stock(store, item)).toBe('0.0000');
  });
});

describe('properties (T-10, BR-12)', () => {
  it('keeps balances equal to the ledger and quantities equal to valuation', async () => {
    const operation = fc.oneof(
      fc.record({
        kind: fc.constant('receive' as const),
        qty: fc.integer({ min: 1, max: 20 }),
        cost: fc.integer({ min: 1, max: 50 }),
      }),
      fc.record({ kind: fc.constant('issue' as const), qty: fc.integer({ min: 1, max: 25 }) }),
      fc.record({ kind: fc.constant('return' as const), qty: fc.integer({ min: 1, max: 10 }) }),
      fc.record({ kind: fc.constant('move' as const), qty: fc.integer({ min: 1, max: 15 }) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 8 }), async (operations) => {
        const a = await kit.store();
        const b = await kit.store();
        const item = await kit.item();
        const issues: string[] = [];
        for (const op of operations) {
          try {
            if (op.kind === 'receive') {
              await kit.receive(a, [
                { itemId: item, quantity: String(op.qty), unitCost: String(op.cost) },
              ]);
            } else if (op.kind === 'issue') {
              issues.push(
                (await kit.issue({ storeId: a, itemId: item, quantity: String(op.qty) }, projectId))
                  .id,
              );
            } else if (op.kind === 'return' && issues.length > 0) {
              await run((t) =>
                kit.inventory.returnToStore(
                  {
                    issueId: issues[0] as string,
                    quantity: String(op.qty),
                    businessDate: '2026-10-25',
                  },
                  kit.actor,
                  t,
                ),
              );
            } else if (op.kind === 'move') {
              const draft = await newTransfer(a, b, [{ itemId: item, quantity: String(op.qty) }]);
              const sent = await run((t) =>
                svc().transfers.send(draft.id, draft.version, kit.actor, t),
              );
              await run((t) => svc().transfers.receive(draft.id, sent.version, kit.actor, t));
            }
          } catch (error) {
            // A refused operation (stock, return limit) changes nothing.
            expect((error as { kind?: string }).kind).toBeDefined();
          }
        }
        expect((await svc().stock.integrity(kit.db)).differences).toEqual([]);
        const sumA = Number(await kit.stock(a, item));
        const sumB = Number(await kit.stock(b, item));
        const valued = await kit.valuation.getTotalValue(kit.db, { itemId: item });
        const quantity = valued.items.reduce((sum, row) => sum + Number(row.quantity), 0);
        expect(quantity).toBe(sumA + sumB);
      }),
      { numRuns: 15 },
    );
  }, 120_000);
});
