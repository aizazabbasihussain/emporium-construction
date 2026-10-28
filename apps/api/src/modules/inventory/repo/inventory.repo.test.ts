import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInventoryKit, uid, type InventoryKit } from '../test-support.js';
import {
  balanceOf,
  findCount,
  findIssue,
  findIssueByKey,
  findLedgerByKey,
  findStore,
  findStoreByCode,
  findTransfer,
  hasOutflowSince,
  insertCount,
  insertCountLine,
  insertIssue,
  insertLedger,
  insertStore,
  insertTransfer,
  insertTransferLine,
  integrityRows,
  listClientMaterial,
  listCountLines,
  listLedgerBySource,
  listTransferLines,
  lockBalance,
  lockReorderLevel,
  recordIssueReturn,
  searchCounts,
  searchLedger,
  searchStock,
  searchStores,
  searchTransfers,
  setBalance,
  setReorderAlerted,
  updateCount,
  updateTransfer,
  upsertReorderLevel,
  type LedgerInsert,
} from './inventory.repo.js';

let kit: InventoryKit;
const at = new Date('2026-10-25T10:00:00Z');
const by = uid(5);
const STORE = uid(5001);
const OTHER = uid(5002);
const ITEM = uid(5003);
const PROJECT = uid(5004);
const CLIENT = uid(5005);

const ledgerRow = (n: number, over: Partial<LedgerInsert> = {}): LedgerInsert => ({
  id: uid(6000 + n),
  storeId: STORE,
  itemId: ITEM,
  ownership: 'company',
  ownerPartyId: null,
  movementType: 'receipt',
  quantity: '10.0000',
  unitCost: '5.0000',
  value: '50.00',
  costObjectType: null,
  costObjectId: null,
  sourceDocType: 'grn',
  sourceDocId: uid(6900),
  sourceLineId: uid(6901),
  businessDate: '2026-10-25',
  postedAt: at,
  idempotencyKey: `repo-${n}`,
  reversesId: null,
  createdBy: by,
  ...over,
});

beforeAll(async () => {
  kit = await createInventoryKit();
  await insertStore(
    kit.db,
    { id: STORE, code: 'R-1', name: 'Repo one', kind: 'warehouse' },
    by,
    at,
  );
  await insertStore(
    kit.db,
    { id: OTHER, code: 'R-2', name: 'Repo two', kind: 'site', project_id: PROJECT },
    by,
    at,
  );
}, 120_000);
afterAll(() => kit.close());

describe('stores', () => {
  it('inserts, finds and searches', async () => {
    expect(await findStore(kit.db, STORE)).toMatchObject({ code: 'R-1', active: true, version: 1 });
    expect(await findStore(kit.db, STORE, true)).toBeDefined();
    expect(await findStoreByCode(kit.db, 'R-2')).toMatchObject({ id: OTHER, project_id: PROJECT });
    expect(await findStoreByCode(kit.db, 'nope')).toBeUndefined();
    const all = await searchStores(kit.db, { limit: 50, offset: 0 });
    expect(all.rows.map((r) => r.code)).toEqual(expect.arrayContaining(['R-1', 'R-2']));
    expect(
      (await searchStores(kit.db, { projectIds: [PROJECT], limit: 5, offset: 0 })).rows,
    ).toHaveLength(1);
    expect((await searchStores(kit.db, { active: false, limit: 5, offset: 0 })).total).toBe(0);
    expect((await searchStores(kit.db, { limit: 1, offset: 1 })).rows).toHaveLength(1);
  });

  it('refuses a warehouse with a project and a duplicate code', async () => {
    await expect(
      insertStore(
        kit.db,
        { id: uid(5010), code: 'R-9', name: 'x', kind: 'warehouse', project_id: PROJECT },
        by,
        at,
      ),
    ).rejects.toThrow();
    await expect(
      insertStore(kit.db, { id: uid(5011), code: 'R-1', name: 'x', kind: 'site' }, by, at),
    ).rejects.toThrow();
  });
});

describe('balances and ledger', () => {
  const key = { storeId: STORE, itemId: ITEM, ownership: 'company', ownerPartyId: null };

  it('creates the balance row once, locks it and keeps the owner key apart', async () => {
    const first = await lockBalance(kit.db, uid(5101), key, at);
    const again = await lockBalance(kit.db, uid(5102), key, at);
    expect(again.id).toBe(first.id);
    expect(first.quantity).toBe('0.0000');
    const client = await lockBalance(
      kit.db,
      uid(5103),
      { ...key, ownership: 'client', ownerPartyId: CLIENT },
      at,
    );
    expect(client.id).not.toBe(first.id);
    await setBalance(kit.db, first.id, '12.5000', at);
    expect(await balanceOf(kit.db, key)).toBe('12.5000');
    expect(await balanceOf(kit.db, { ...key, itemId: uid(5199) })).toBe('0.0000');
    await expect(setBalance(kit.db, first.id, '-1', at)).rejects.toThrow();
  });

  it('appends ledger rows and finds them by key and source', async () => {
    const row = await insertLedger(kit.db, ledgerRow(1));
    expect(row).toMatchObject({
      movement_type: 'receipt',
      quantity: '10.0000',
      value: '50.00',
      business_date: '2026-10-25',
    });
    expect(Number(row.seq)).toBeGreaterThan(0);
    expect((await findLedgerByKey(kit.db, 'repo-1'))?.id).toBe(row.id);
    expect(await findLedgerByKey(kit.db, 'none')).toBeUndefined();
    expect((await listLedgerBySource(kit.db, 'grn', uid(6900))).map((r) => r.id)).toEqual([row.id]);
    await insertLedger(
      kit.db,
      ledgerRow(2, {
        movementType: 'issue',
        quantity: '-4.0000',
        value: '20.00',
        costObjectType: 'project',
        costObjectId: PROJECT,
        sourceDocType: 'issue',
        sourceDocId: uid(6902),
      }),
    );
    const found = await searchLedger(kit.db, {
      storeId: STORE,
      itemId: ITEM,
      limit: 10,
      offset: 0,
    });
    expect(found.total).toBe(2);
    expect(found.rows[0]?.movement_type).toBe('issue');
    expect(
      (
        await searchLedger(kit.db, {
          movementType: 'receipt',
          ownership: 'company',
          limit: 10,
          offset: 0,
        })
      ).total,
    ).toBe(1);
    expect(
      (await searchLedger(kit.db, { projectIds: [PROJECT], limit: 10, offset: 0 })).total,
    ).toBe(0);
    expect(
      (await searchLedger(kit.db, { projectIds: [PROJECT], storeId: OTHER, limit: 10, offset: 0 }))
        .total,
    ).toBe(0);
  });

  it('refuses updates, deletes and impossible rows', async () => {
    await expect(
      kit.db.query("update inv_ledger set value = 1 where idempotency_key = 'repo-1'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      kit.db.query("delete from inv_ledger where idempotency_key = 'repo-1'"),
    ).rejects.toThrow(/append-only/);
    await expect(kit.db.query('truncate inv_ledger')).rejects.toThrow(/append-only/);
    await expect(insertLedger(kit.db, ledgerRow(3, { quantity: '-1.0000' }))).rejects.toThrow();
    await expect(insertLedger(kit.db, ledgerRow(4, { ownership: 'client' }))).rejects.toThrow();
    await expect(
      insertLedger(kit.db, ledgerRow(5, { idempotencyKey: 'repo-1' })),
    ).rejects.toThrow();
    await expect(
      insertLedger(kit.db, ledgerRow(6, { ownership: 'client', ownerPartyId: CLIENT })),
    ).rejects.toThrow();
  });

  it('searches stock and reports balances that differ from the ledger', async () => {
    const stock = await searchStock(kit.db, {
      storeId: STORE,
      itemId: ITEM,
      ownership: 'company',
      limit: 10,
      offset: 0,
    });
    expect(stock.rows).toHaveLength(1);
    expect((await searchStock(kit.db, { projectIds: [PROJECT], limit: 10, offset: 0 })).total).toBe(
      0,
    );
    const report = await integrityRows(kit.db);
    const own = report.differences.find((d) => d.store_id === STORE && d.ownership === 'company');
    // Balance 12.5 against a ledger of 10 - 4 = 6.
    expect(own).toMatchObject({ balance: '12.5000' });
    expect(Number(own?.ledger_sum)).toBe(6);
    expect(report.checked).toBeGreaterThanOrEqual(2);
  });

  it('knows whether stock left after a receipt', async () => {
    expect(await hasOutflowSince(kit.db, uid(6900))).toBe(true);
    expect(await hasOutflowSince(kit.db, uid(6999))).toBe(false);
  });

  it('shows client material per project through the view', async () => {
    await insertLedger(
      kit.db,
      ledgerRow(10, {
        ownership: 'client',
        ownerPartyId: CLIENT,
        movementType: 'client_receipt',
        quantity: '8.0000',
        unitCost: null,
        value: null,
        costObjectType: 'project',
        costObjectId: PROJECT,
        sourceDocType: 'client_receipt',
        sourceDocId: uid(6910),
        sourceLineId: null,
      }),
    );
    await insertLedger(
      kit.db,
      ledgerRow(11, {
        ownership: 'client',
        ownerPartyId: CLIENT,
        movementType: 'issue',
        quantity: '-3.0000',
        unitCost: null,
        value: null,
        costObjectType: 'project',
        costObjectId: PROJECT,
        sourceDocType: 'issue',
        sourceDocId: uid(6911),
        sourceLineId: null,
      }),
    );
    const rows = await listClientMaterial(kit.db, PROJECT);
    expect(rows).toEqual([
      expect.objectContaining({
        received_qty: '8.0000',
        used_qty: '3.0000',
        returned_qty: '0.0000',
        balance_qty: '5.0000',
      }),
    ]);
    const view = await kit.db.query<{ quantity: string }>(
      'select quantity::text as quantity from inv_v_stock_on_hand where store_id = $1 and ownership = $2',
      [STORE, 'company'],
    );
    expect(view[0]?.quantity).toBe('12.5000');
  });
});

describe('issues', () => {
  it('records an issue, finds it by id and key and restates it after a return', async () => {
    const issue = await insertIssue(
      kit.db,
      {
        id: uid(5201),
        store_id: STORE,
        item_id: ITEM,
        ownership: 'company',
        quantity: '10.0000',
        value: '500.00',
        cost_object_type: 'project',
        cost_object_id: PROJECT,
        cost_code_id: uid(5202),
        valuation_movement_id: uid(5203),
        cost_entry_id: uid(5204),
        business_date: '2026-10-25',
        idempotency_key: 'issue-key',
      },
      by,
      at,
    );
    expect(issue).toMatchObject({
      returned_quantity: '0.0000',
      returned_value: '0.00',
      version: 1,
    });
    expect((await findIssue(kit.db, issue.id, true))?.idempotency_key).toBe('issue-key');
    expect((await findIssueByKey(kit.db, 'issue-key'))?.id).toBe(issue.id);
    expect(await findIssue(kit.db, uid(5299))).toBeUndefined();
    expect(await findIssueByKey(kit.db, 'none')).toBeUndefined();
    await recordIssueReturn(kit.db, issue.id, {
      returnedQuantity: '4.0000',
      returnedValue: '200.00',
      costEntryId: null,
      by,
      at,
    });
    expect(await findIssue(kit.db, issue.id)).toMatchObject({
      returned_quantity: '4.0000',
      returned_value: '200.00',
      cost_entry_id: null,
      version: 2,
    });
    await expect(
      recordIssueReturn(kit.db, issue.id, {
        returnedQuantity: '11',
        returnedValue: '0',
        costEntryId: null,
        by,
        at,
      }),
    ).rejects.toThrow();
  });
});

describe('transfers', () => {
  it('stores a transfer with its lines and moves it between statuses', async () => {
    const transfer = await insertTransfer(
      kit.db,
      {
        id: uid(5301),
        number: 'STR-R-1',
        from_store_id: STORE,
        to_store_id: OTHER,
        business_date: '2026-10-25',
      },
      by,
      at,
    );
    await insertTransferLine(kit.db, {
      id: uid(5302),
      transfer_id: transfer.id,
      item_id: ITEM,
      ownership: 'client',
      owner_party_id: CLIENT,
      project_id: PROJECT,
      quantity: '3.0000',
    });
    expect(await listTransferLines(kit.db, transfer.id)).toEqual([
      expect.objectContaining({
        ownership: 'client',
        owner_party_id: CLIENT,
        project_id: PROJECT,
        quantity: '3.0000',
      }),
    ]);
    expect((await findTransfer(kit.db, transfer.id, true))?.status).toBe('draft');
    const sent = await updateTransfer(kit.db, transfer.id, 1, { status: 'in_transit' }, by, at);
    expect(sent).toMatchObject({ status: 'in_transit', version: 2 });
    expect(
      await updateTransfer(kit.db, transfer.id, 1, { status: 'received' }, by, at),
    ).toBeUndefined();
    expect(
      (await searchTransfers(kit.db, { status: 'in_transit', limit: 10, offset: 0 })).total,
    ).toBe(1);
    expect((await searchTransfers(kit.db, { limit: 10, offset: 0 })).rows).toHaveLength(1);
    await expect(
      insertTransfer(
        kit.db,
        {
          id: uid(5303),
          number: 'STR-R-2',
          from_store_id: STORE,
          to_store_id: STORE,
          business_date: '2026-10-25',
        },
        by,
        at,
      ),
    ).rejects.toThrow();
  });
});

describe('counts and reorder levels', () => {
  it('stores a count sheet and updates its status', async () => {
    const count = await insertCount(
      kit.db,
      { id: uid(5401), number: 'CNT-R-1', store_id: STORE, counted_on: '2026-10-25' },
      by,
      at,
    );
    await insertCountLine(kit.db, {
      id: uid(5402),
      count_id: count.id,
      item_id: ITEM,
      ownership: 'company',
      owner_party_id: null,
      system_qty: '10.0000',
      counted_qty: '8.0000',
    });
    expect(await listCountLines(kit.db, count.id)).toEqual([
      expect.objectContaining({ system_qty: '10.0000', counted_qty: '8.0000' }),
    ]);
    expect((await findCount(kit.db, count.id, true))?.counted_on).toBe('2026-10-25');
    expect(await updateCount(kit.db, count.id, 1, { status: 'counted' }, null, at)).toMatchObject({
      status: 'counted',
    });
    expect((await searchCounts(kit.db, { status: 'counted', limit: 5, offset: 0 })).total).toBe(1);
    expect((await searchCounts(kit.db, { limit: 5, offset: 0 })).rows).toHaveLength(1);
  });

  it('sets a level, locks it and flips the alerted flag', async () => {
    const level = await upsertReorderLevel(kit.db, {
      storeId: STORE,
      itemId: ITEM,
      level: '5.0000',
      by,
      at,
    });
    expect(level).toMatchObject({ level: '5.0000', alerted: false });
    await setReorderAlerted(kit.db, STORE, ITEM, true);
    expect((await lockReorderLevel(kit.db, STORE, ITEM))?.alerted).toBe(true);
    const changed = await upsertReorderLevel(kit.db, {
      storeId: STORE,
      itemId: ITEM,
      level: '8.0000',
      by,
      at,
    });
    expect(changed).toMatchObject({ level: '8.0000', alerted: true });
    expect(await lockReorderLevel(kit.db, STORE, uid(5499))).toBeUndefined();
  });
});

describe('schema', () => {
  it('has row level security on every inventory table (constitution 7.7)', async () => {
    const rows = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'inv\\_%'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.every((row) => row.relrowsecurity)).toBe(true);
  });
});
