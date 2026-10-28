import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  createInventoryKit,
  eventCount,
  MISSING,
  STOREKEEPER,
  SUPERVISOR,
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

const tx = <T>(fn: Parameters<InventoryKit['db']['transaction']>[0]) =>
  kit.db.transaction<T>(fn as never);

const returnOf = (
  issueId: string,
  quantity: string,
  over: Record<string, unknown> = {},
  actor = kit.actor,
) =>
  tx<ReturnType<typeof kit.inventory.returnToStore> extends Promise<infer R> ? R : never>((t) =>
    kit.inventory.returnToStore(
      { issueId, quantity, businessDate: '2026-10-25', ...over },
      actor,
      t,
    ),
  );

beforeAll(async () => {
  kit = await createInventoryKit();
  projectId = (await kit.project()).id;
}, 120_000);
afterAll(() => kit.close());

describe('goods receipts become stock (BR-2, T-1)', () => {
  it('adds the accepted quantity at the unit cost and ignores a replayed event', async () => {
    const store = await kit.store();
    const item = await kit.item();
    const { grnId } = await kit.receive(store, [
      { itemId: item, quantity: '30', unitCost: '1200' },
    ]);
    expect(await kit.stock(store, item)).toBe('30.0000');
    const ledger = await kit.inventory.service.stock.listLedger(
      kit.db,
      { storeId: store, limit: 10, offset: 0 },
      kit.actor,
    );
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).toMatchObject({
      movementType: 'receipt',
      quantity: '30.0000',
      unitCost: '1200.0000',
      value: '36000.00',
      sourceDocType: 'grn',
      sourceDocId: grnId,
    });
    expect(await eventCount(kit.db, 'stock.received')).toBeGreaterThan(0);
    // The same receipt line again changes nothing: the handler is idempotent on the line id.
    await kit.db.transaction(async (t) => {
      await kit.inventory.service.stock.receiveFromGrn(
        {
          grnId,
          grnNumber: 'GRN-X',
          destinationType: 'store',
          storeId: store,
          ownership: 'company',
          lines: [
            {
              grnLineId: ledger.items[0]?.sourceLineId as string,
              itemId: item,
              quantity: '30',
              unitCost: '1200',
            },
          ],
        },
        t,
      );
    });
    expect(await kit.stock(store, item)).toBe('30.0000');
  });

  it('ignores a receipt that goes straight to a project', async () => {
    const item = await kit.item();
    await kit.db.transaction((t) =>
      kit.inventory.service.stock.receiveFromGrn(
        {
          grnId: uid(1),
          grnNumber: 'GRN-P',
          destinationType: 'project',
          storeId: null,
          ownership: 'company',
          lines: [{ grnLineId: uid(2), itemId: item, quantity: '5', unitCost: '10' }],
        },
        t,
      ),
    );
    const stock = await kit.inventory.service.stock.listStock(
      kit.db,
      { itemId: item, limit: 10, offset: 0 },
      kit.actor,
    );
    expect(stock.total).toBe(0);
  });

  it('refuses a receipt of an unknown store or a service item', async () => {
    const item = await kit.item();
    const goods = (storeId: string, itemId: string) =>
      kit.db.transaction((t) =>
        kit.inventory.service.stock.receiveFromGrn(
          {
            grnId: uid(3),
            grnNumber: 'GRN-B',
            destinationType: 'store',
            storeId,
            ownership: 'company',
            lines: [{ grnLineId: uid(4), itemId, quantity: '5', unitCost: '10' }],
          },
          t,
        ),
      );
    expect(await codeOf(goods(MISSING, item))).toBe('store_not_found');
    const store = await kit.store();
    expect(await codeOf(goods(store, MISSING))).toBe('item_not_found');
  });

  it('keeps company and client stock apart (T-1)', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '5' }]);
    await tx((t) =>
      kit.inventory.receiveClientMaterial(
        {
          storeId: store,
          itemId: item,
          quantity: '7',
          ownerPartyId: kit.clientParty,
          projectId,
          businessDate: '2026-10-25',
        },
        kit.actor,
        t,
      ),
    );
    expect(await kit.stock(store, item)).toBe('10.0000');
    expect(await kit.inventory.getStockOnHand(kit.db, store, item, 'client', kit.clientParty)).toBe(
      '7.0000',
    );
  });
});

describe('issue to a project (BR-1, BR-3, T-2, T-3)', () => {
  it('reduces stock and posts the valued cost to the project (AC-1)', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '30', unitCost: '1200' }]);
    const issue = await kit.issue({ storeId: store, itemId: item, quantity: '10' }, projectId);
    expect(issue).toMatchObject({ quantity: '10.0000', value: '12000.00' });
    expect(issue.costEntryId).not.toBeNull();
    expect(await kit.stock(store, item)).toBe('20.0000');
    const costs = (await kit.costs(projectId)).filter((c) => c.sourceDocType === 'stock_issue');
    expect(costs.at(-1)).toMatchObject({ status: 'posted', amount: '12000.00' });
    expect(await auditCount(kit.db, 'inventory.stock.issue')).toBeGreaterThan(0);
    expect(await eventCount(kit.db, 'stock.issued')).toBeGreaterThan(0);
  });

  it('allows exactly the balance and refuses one more with the shortfall (T-2)', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '5', unitCost: '10' }]);
    let details: unknown;
    try {
      await kit.issue({ storeId: store, itemId: item, quantity: '5.0001' }, projectId);
    } catch (error) {
      details = (error as { details?: unknown }).details;
    }
    expect(details).toEqual({ shortfall: '0.0001', available: '5.0000' });
    await kit.issue({ storeId: store, itemId: item, quantity: '5' }, projectId);
    expect(await kit.stock(store, item)).toBe('0.0000');
  });

  it('uses the cost code of the command over the default of the item', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '4', unitCost: '10' }]);
    const cement = await kit.db.transaction((t) =>
      kit.masterData.costing.createCostCode(
        { code: '101', name: 'Cement', parentId: kit.codes['100'], kind: 'material' },
        { userId: uid(1), requestId: null },
        t,
      ),
    );
    const issue = await kit.issue(
      { storeId: store, itemId: item, quantity: '1', costCodeId: cement.id },
      projectId,
    );
    const summary = await kit.projects.getCostSummary(kit.db, { type: 'project', id: projectId });
    expect(summary.lines.some((line) => line.costCodeId === cement.id)).toBe(true);
    expect(issue.costEntryId).not.toBeNull();
  });

  it('refuses an issue when neither the command nor the item names a cost code', async () => {
    const store = await kit.store();
    const item = await kit.item({ defaultCostCode: null });
    await kit.receive(store, [{ itemId: item, quantity: '4', unitCost: '10' }]);
    expect(
      await codeOf(kit.issue({ storeId: store, itemId: item, quantity: '1' }, projectId)),
    ).toBe('cost_code_required');
    expect(await kit.stock(store, item)).toBe('4.0000');
  });

  it('refuses a closed project, an unknown item, a service item and an inactive store', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '4', unitCost: '10' }]);
    const planning = await kit.db.transaction((t) =>
      kit.projects.service.create(
        { name: 'Other', partyId: kit.clientParty, sector: 'private', originalContractValue: '10' },
        kit.actorFor(uid(3)),
        t,
      ),
    );
    await kit.db.transaction((t) =>
      kit.projects.service.transition(
        planning.id,
        'cancelled',
        planning.version,
        kit.actorFor(uid(3)),
        t,
      ),
    );
    expect(
      await codeOf(kit.issue({ storeId: store, itemId: item, quantity: '1' }, planning.id)),
    ).toBe('project_not_open');
    expect(
      await codeOf(kit.issue({ storeId: store, itemId: MISSING, quantity: '1' }, projectId)),
    ).toBe('item_not_found');
    const loose = await kit.item({ stockable: false });
    expect(
      await codeOf(kit.issue({ storeId: store, itemId: loose, quantity: '1' }, projectId)),
    ).toBe('item_not_stockable');
    expect(
      await codeOf(kit.issue({ storeId: MISSING, itemId: item, quantity: '1' }, projectId)),
    ).toBe('store_not_found');
    await kit.db.query('update inv_stores set active = false where id = $1', [store]);
    expect(
      await codeOf(kit.issue({ storeId: store, itemId: item, quantity: '1' }, projectId)),
    ).toBe('store_inactive');
  });

  it('refuses a project cost object without an id and negative stock settings', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '4', unitCost: '10' }]);
    expect(
      await codeOf(
        kit.issue(
          {
            storeId: store,
            itemId: item,
            quantity: '1',
            costObject: { type: 'project', id: null },
          },
          projectId,
        ),
      ),
    ).toBe('cost_object_required');
    await kit.setting('inventory.allow_negative_stock', true);
    expect(
      await codeOf(kit.issue({ storeId: store, itemId: item, quantity: '1' }, projectId)),
    ).toBe('negative_stock_unsupported');
    await kit.setting('inventory.allow_negative_stock', false);
  });

  it('replays an issue with the same idempotency key', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '4', unitCost: '10' }]);
    const first = await kit.issue(
      { storeId: store, itemId: item, quantity: '1', idempotencyKey: 'issue-once' },
      projectId,
    );
    const second = await kit.issue(
      { storeId: store, itemId: item, quantity: '1', idempotencyKey: 'issue-once' },
      projectId,
    );
    expect(second.id).toBe(first.id);
    expect(await kit.stock(store, item)).toBe('3.0000');
  });

  it('lets a supervisor issue on an assigned project store only when the setting is on', async () => {
    const site = await kit.store({ projectId, kind: 'site' });
    const warehouse = await kit.store();
    const item = await kit.item();
    await kit.receive(site, [{ itemId: item, quantity: '10', unitCost: '10' }]);
    await kit.receive(warehouse, [{ itemId: item, quantity: '10', unitCost: '10' }]);
    await kit.assignSupervisor(projectId, SUPERVISOR);
    const supervisor = {
      userId: SUPERVISOR,
      roles: ['supervisor'],
      scopes: [{ type: 'project' as const, id: projectId }],
      permissions: new Set(['inventory.stock.read']),
      requestId: null,
    };
    const run = (storeId: string) =>
      tx((t) =>
        kit.inventory.issueToCostObject(
          {
            storeId,
            itemId: item,
            quantity: '1',
            costObject: { type: 'project', id: projectId },
            businessDate: '2026-10-25',
          },
          supervisor,
          t,
        ),
      );
    expect(await codeOf(run(site))).toBe('forbidden');
    await kit.setting('inventory.supervisor_can_issue', true);
    await run(site);
    expect(await codeOf(run(warehouse))).toBe('store_not_found');
    await kit.setting('inventory.supervisor_can_issue', false);
  });

  it('checks the business date (BR-9)', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '4', unitCost: '10' }]);
    expect(
      await codeOf(
        kit.issue(
          { storeId: store, itemId: item, quantity: '1', businessDate: '2026-10-26' },
          projectId,
        ),
      ),
    ).toBe('date_in_future');
    expect(
      await codeOf(
        kit.issue(
          { storeId: store, itemId: item, quantity: '1', businessDate: '2026-09-01' },
          projectId,
        ),
      ),
    ).toBeDefined();
  });
});

describe('client-owned material (BR-5, T-4, AC-2)', () => {
  it('is tracked by quantity and never posts a cost', async () => {
    const store = await kit.store();
    const item = await kit.item();
    const base = { storeId: store, itemId: item, ownerPartyId: kit.clientParty, projectId };
    const receipt = await tx<{ id: string }>((t) =>
      kit.inventory.receiveClientMaterial(
        { ...base, quantity: '20', businessDate: '2026-10-25' },
        kit.actor,
        t,
      ),
    );
    expect(receipt).toBeDefined();
    const costsBefore = (await kit.costs(projectId)).length;
    const issue = await kit.issue(
      {
        storeId: store,
        itemId: item,
        quantity: '8',
        ownership: 'client',
        ownerPartyId: kit.clientParty,
      },
      projectId,
    );
    expect(issue).toMatchObject({ value: null, costEntryId: null });
    expect(issue.ledger[0]).toMatchObject({ unitCost: null, value: null, ownership: 'client' });
    expect((await kit.costs(projectId)).length).toBe(costsBefore);
    await tx((t) =>
      kit.inventory.service.stock.returnClientMaterial(
        { ...base, quantity: '2', businessDate: '2026-10-25' },
        kit.actor,
        t,
      ),
    );
    const rows = await kit.inventory.service.stock.clientMaterial(kit.db, projectId);
    const row = rows.find((r) => r.storeId === store && r.itemId === item);
    expect(row).toMatchObject({
      received: '20.0000',
      used: '8.0000',
      returned: '2.0000',
      balance: '10.0000',
    });
    expect(await kit.stock(store, item)).toBe('0.0000');
  });

  it('refuses a non-client owner, a missing owner and company stock with an owner', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '5', unitCost: '10' }]);
    const vendor = await kit.db.transaction((t) =>
      kit.masterData.parties.create(
        { name: 'V', roles: ['vendor'], city: 'Lahore' },
        { userId: uid(1), requestId: null },
        t,
      ),
    );
    const base = {
      storeId: store,
      itemId: item,
      quantity: '1',
      costObject: { type: 'project' as const, id: projectId },
    };
    expect(
      await codeOf(kit.issue({ ...base, ownership: 'client', ownerPartyId: vendor.id }, projectId)),
    ).toBe('client_not_found');
    expect(await codeOf(kit.issue({ ...base, ownership: 'client' }, projectId))).toBe(
      'owner_required',
    );
    expect(await codeOf(kit.issue({ ...base, ownerPartyId: kit.clientParty }, projectId))).toBe(
      'owner_not_allowed',
    );
    expect(
      await codeOf(
        kit.issue(
          {
            ...base,
            ownership: 'client',
            ownerPartyId: kit.clientParty,
            costObject: { type: 'overhead', id: null },
          },
          projectId,
        ),
      ),
    ).toBe('client_material_project');
  });

  it('repeats a client receipt by key without adding stock twice', async () => {
    const store = await kit.store();
    const item = await kit.item();
    const command = {
      storeId: store,
      itemId: item,
      quantity: '3',
      ownerPartyId: kit.clientParty,
      projectId,
      businessDate: '2026-10-25',
      idempotencyKey: 'client-once',
    };
    await tx((t) => kit.inventory.receiveClientMaterial(command, kit.actor, t));
    await tx((t) => kit.inventory.receiveClientMaterial(command, kit.actor, t));
    expect(await kit.inventory.getStockOnHand(kit.db, store, item, 'client', kit.clientParty)).toBe(
      '3.0000',
    );
  });
});

describe('returns from site (BR-6, T-6)', () => {
  it('reverses the exact original cost and restores stock', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '100' }]);
    const issue = await kit.issue({ storeId: store, itemId: item, quantity: '10' }, projectId);
    const before = (await kit.costs(projectId)).length;
    const back = await returnOf(issue.id, '10');
    expect(back).toMatchObject({ quantity: '10.0000', value: '1000.00' });
    expect(await kit.stock(store, item)).toBe('10.0000');
    const costs = (await kit.costs(projectId)).slice(before);
    expect(costs).toEqual([
      { status: 'reversed', amount: '1000.00', sourceDocType: 'stock_issue', reverses: true },
    ]);
    const summary = await kit.projects.getCostSummary(kit.db, { type: 'project', id: projectId });
    expect(summary).toBeDefined();
  });

  it('restates the cost after a part return and refuses more than is left', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '100' }]);
    const issue = await kit.issue({ storeId: store, itemId: item, quantity: '10' }, projectId);
    await returnOf(issue.id, '4');
    const costs = await kit.costs(projectId);
    expect(costs.slice(-2)).toEqual([
      { status: 'reversed', amount: '1000.00', sourceDocType: 'stock_issue', reverses: true },
      { status: 'posted', amount: '600.00', sourceDocType: 'stock_issue', reverses: false },
    ]);
    expect(await codeOf(returnOf(issue.id, '6.0001'))).toBe('return_exceeds_issue');
    await returnOf(issue.id, '6');
    expect((await kit.costs(projectId)).at(-1)).toMatchObject({
      status: 'reversed',
      amount: '600.00',
    });
    expect(await codeOf(returnOf(issue.id, '1'))).toBe('return_exceeds_issue');
    expect(await kit.stock(store, item)).toBe('10.0000');
  });

  it('refuses unknown issues, client issues and a repeated key', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '100' }]);
    expect(await codeOf(returnOf(MISSING, '1'))).toBe('issue_not_found');
    await tx((t) =>
      kit.inventory.receiveClientMaterial(
        {
          storeId: store,
          itemId: item,
          quantity: '3',
          ownerPartyId: kit.clientParty,
          projectId,
          businessDate: '2026-10-25',
        },
        kit.actor,
        t,
      ),
    );
    const client = await kit.issue(
      {
        storeId: store,
        itemId: item,
        quantity: '2',
        ownership: 'client',
        ownerPartyId: kit.clientParty,
      },
      projectId,
    );
    expect(await codeOf(returnOf(client.id, '1'))).toBe('client_issue_return');
    const issue = await kit.issue({ storeId: store, itemId: item, quantity: '4' }, projectId);
    const first = await returnOf(issue.id, '1', { idempotencyKey: 'ret-once' });
    const second = await returnOf(issue.id, '1', { idempotencyKey: 'ret-once' });
    expect(second.ledger[0]?.id).toBe(first.ledger[0]?.id);
    expect(await kit.stock(store, item)).toBe('7.0000');
  });
});

describe('salvage (BR-7, H-21, T-7)', () => {
  it('enters stock at zero value by default and posts no cost', async () => {
    const store = await kit.store();
    const item = await kit.item();
    const before = (await kit.costs(projectId)).length;
    const salvage = await tx<{ value: string | null; costEntryId: string | null }>((t) =>
      kit.inventory.service.stock.salvage(
        {
          storeId: store,
          itemId: item,
          quantity: '6',
          projectId,
          unitValue: '50',
          businessDate: '2026-10-25',
        },
        kit.actor,
        t,
      ),
    );
    expect(salvage).toMatchObject({ value: '0.00', costEntryId: null });
    expect(await kit.stock(store, item)).toBe('6.0000');
    expect((await kit.costs(projectId)).length).toBe(before);
  });

  it('takes salvage without a project in the default mode', async () => {
    const store = await kit.store();
    const item = await kit.item();
    const salvage = await tx<{ value: string | null }>((t) =>
      kit.inventory.service.stock.salvage(
        { storeId: store, itemId: item, quantity: '2', businessDate: '2026-10-25' },
        kit.actor,
        t,
      ),
    );
    expect(salvage.value).toBe('0.00');
    expect(await kit.stock(store, item)).toBe('2.0000');
  });

  it('credits the project with a negative entry when the value is estimated', async () => {
    await kit.setting('inventory.salvage_value_mode', 'estimated');
    const store = await kit.store();
    const item = await kit.item();
    const run = (over: Record<string, unknown>) =>
      tx<{ value: string | null; costEntryId: string | null }>((t) =>
        kit.inventory.service.stock.salvage(
          {
            storeId: store,
            itemId: item,
            quantity: '6',
            businessDate: '2026-10-25',
            ...over,
          },
          kit.actor,
          t,
        ),
      );
    expect(await codeOf(run({ projectId }))).toBe('unit_value_required');
    expect(await codeOf(run({ unitValue: '50' }))).toBe('project_required');
    const salvage = await run({ projectId, unitValue: '50', idempotencyKey: 'salvage-once' });
    expect(salvage.value).toBe('300.00');
    expect((await kit.costs(projectId)).at(-1)).toMatchObject({
      status: 'posted',
      amount: '-300.00',
      sourceDocType: 'salvage',
    });
    expect(
      (await run({ projectId, unitValue: '50', idempotencyKey: 'salvage-once' })).costEntryId,
    ).toBeNull();
    expect(await kit.stock(store, item)).toBe('6.0000');
    await kit.setting('inventory.salvage_value_mode', 'zero');
  });
});

describe('queries and integrity (BR-12, AC-4)', () => {
  it('reports zero differences after the scripted scenario', async () => {
    const report = await kit.inventory.service.stock.integrity(kit.db);
    expect(report.differences).toEqual([]);
    expect(report.checked).toBeGreaterThan(0);
  });

  it('reports a balance that differs from its ledger', async () => {
    const store = await kit.store();
    const item = await kit.item();
    await kit.db.query(
      `insert into inv_balances (id, store_id, item_id, ownership, quantity) values ($1, $2, $3, 'company', 4)`,
      [uid(7001), store, item],
    );
    const report = await kit.inventory.service.stock.integrity(kit.db);
    expect(report.differences).toEqual([
      expect.objectContaining({
        storeId: store,
        itemId: item,
        balance: '4.0000',
        ledgerSum: '0',
        difference: '4.0000',
      }),
    ]);
    await kit.db.query('delete from inv_balances where id = $1', [uid(7001)]);
  });

  it('filters stock and ledger and limits a supervisor to the stores of their projects', async () => {
    const site = await kit.store({ projectId, kind: 'site' });
    const warehouse = await kit.store();
    const item = await kit.item();
    await kit.receive(site, [{ itemId: item, quantity: '3', unitCost: '10' }]);
    await kit.receive(warehouse, [{ itemId: item, quantity: '2', unitCost: '10' }]);
    const supervisor = kit.actorFor(SUPERVISOR, [{ type: 'project', id: projectId }]);
    const own = await kit.inventory.service.stock.listStock(
      kit.db,
      { itemId: item, ownership: 'company', limit: 10, offset: 0 },
      supervisor,
    );
    expect(own.items.map((s) => s.storeId)).toEqual([site]);
    const all = await kit.inventory.service.stock.listStock(
      kit.db,
      { itemId: item, limit: 10, offset: 0 },
      kit.actor,
    );
    expect(all.total).toBe(2);
    const ledger = await kit.inventory.service.stock.listLedger(
      kit.db,
      { itemId: item, movementType: 'receipt', limit: 10, offset: 0 },
      supervisor,
    );
    expect(ledger.items.map((row) => row.storeId)).toEqual([site]);
  });

  it('tells whether stock left the store after a receipt (hasIssuesFromGrn)', async () => {
    const store = await kit.store();
    const item = await kit.item();
    const { grnId } = await kit.receive(store, [{ itemId: item, quantity: '5', unitCost: '10' }]);
    expect(await kit.inventory.hasIssuesFromGrn(kit.db, grnId)).toBe(false);
    await kit.issue({ storeId: store, itemId: item, quantity: '1' }, projectId);
    expect(await kit.inventory.hasIssuesFromGrn(kit.db, grnId)).toBe(true);
    void STOREKEEPER;
  });
});

describe('first in, first out (T-3)', () => {
  it('writes one ledger row per FIFO layer and one cost entry equal to their sum (T-3)', async () => {
    await kit.activatePolicy('fifo');
    const store = await kit.store();
    const item = await kit.item();
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '100' }]);
    await kit.receive(store, [{ itemId: item, quantity: '10', unitCost: '130' }]);
    const before = (await kit.costs(projectId)).length;
    const issue = await kit.issue({ storeId: store, itemId: item, quantity: '15' }, projectId);
    expect(issue.ledger).toHaveLength(2);
    expect(issue.ledger.map((row) => row.value)).toEqual(['1000.00', '650.00']);
    expect(issue.value).toBe('1650.00');
    const costs = await kit.costs(projectId);
    expect(costs).toHaveLength(before + 1);
    expect(costs.at(-1)).toMatchObject({ status: 'posted', amount: '1650.00' });
  });
});
