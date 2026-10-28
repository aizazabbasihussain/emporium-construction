/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument --
   These tests read untyped JSON bodies of the HTTP API. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  MANAGEMENT,
  MISSING,
  NOBODY,
  STOREKEEPER,
  SUPERVISOR,
  createInventoryKit,
  type InventoryKit,
} from '../test-support.js';

vi.setConfig({ testTimeout: 60_000 });

let kit: InventoryKit;
let projectId: string;
beforeAll(async () => {
  kit = await createInventoryKit();
  projectId = (await kit.project()).id;
}, 120_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = STOREKEEPER, body, key }: Call) => {
  const response = await kit.app.inject({
    method,
    url,
    headers: {
      ...(await kit.auth(user)),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return {
    status: response.statusCode,
    body: response.body === '' ? null : response.json<unknown>(),
  };
};
const errorCode = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

let keyCounter = 0;
const newKey = () => `inv-key-${++keyCounter}`;
const post = (url: string, body: unknown, user = STOREKEEPER) =>
  call({ method: 'POST', url, user, body, key: newKey() });
const put = (url: string, body: unknown, user = STOREKEEPER) =>
  call({ method: 'PUT', url, user, body, key: newKey() });
const get = (url: string, user = STOREKEEPER) => call({ method: 'GET', url, user });

type Json = Record<string, any>;

const stocked = async (quantity = '20') => {
  const store = await kit.store();
  const item = await kit.item();
  await kit.receive(store, [{ itemId: item, quantity, unitCost: '10' }]);
  return { store, item };
};

const issueBody = (store: string, item: string, over: Json = {}) => ({
  storeId: store,
  itemId: item,
  quantity: '2',
  costObject: { type: 'project', id: projectId },
  businessDate: '2026-10-25',
  ...over,
});

describe('stores', () => {
  it('creates, lists and refuses', async () => {
    const created = await post('/inventory/stores', {
      code: 'RT-1',
      name: 'Route store',
      kind: 'warehouse',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'RT-1', kind: 'warehouse', active: true });
    const listed = await get('/inventory/stores?active=true');
    expect(listed.status).toBe(200);
    expect((listed.body as Json).items.some((s: Json) => s.code === 'RT-1')).toBe(true);
    expect(
      await post('/inventory/stores', { code: 'RT-1', name: 'x', kind: 'warehouse' }),
    ).toMatchObject({ status: 409 });
    expect(
      errorCode(await post('/inventory/stores', { code: '', name: 'x', kind: 'warehouse' })),
    ).toBe('validation_failed');
    expect(
      (await post('/inventory/stores', { code: 'RT-2', name: 'x', kind: 'site' }, ACCOUNTANT))
        .status,
    ).toBe(403);
    expect((await get('/inventory/stores', NOBODY)).status).toBe(403);
    expect((await get('/inventory/stores?limit=0')).status).toBe(400);
  });

  it('replays a create with the same idempotency key', async () => {
    const key = newKey();
    const body = { code: 'RT-IDEM', name: 'Once', kind: 'warehouse' };
    const first = await call({ method: 'POST', url: '/inventory/stores', body, key });
    const second = await call({ method: 'POST', url: '/inventory/stores', body, key });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    const stores = await get('/inventory/stores?limit=200');
    expect((stores.body as Json).items.filter((s: Json) => s.code === 'RT-IDEM')).toHaveLength(1);
    expect(
      (await call({ method: 'POST', url: '/inventory/stores', body, key: ['a', 'b'] as never }))
        .status,
    ).toBeDefined();
  });

  it('sets a reorder level', async () => {
    const { store, item } = await stocked();
    const level = await put('/inventory/reorder-levels', {
      storeId: store,
      itemId: item,
      level: '5',
    });
    expect(level).toMatchObject({
      status: 200,
      body: { storeId: store, itemId: item, level: '5.0000' },
    });
    expect(
      errorCode(
        await put('/inventory/reorder-levels', { storeId: MISSING, itemId: item, level: '5' }),
      ),
    ).toBe('store_not_found');
    expect(
      errorCode(
        await put('/inventory/reorder-levels', { storeId: store, itemId: item, level: '-1' }),
      ),
    ).toBe('validation_failed');
    expect(
      (
        await put(
          '/inventory/reorder-levels',
          { storeId: store, itemId: item, level: '5' },
          SUPERVISOR,
        )
      ).status,
    ).toBe(403);
  });
});

describe('stock, ledger and reports', () => {
  it('lists stock and ledger rows with filters', async () => {
    const { store, item } = await stocked();
    const stock = await get(`/inventory/stock?storeId=${store}&itemId=${item}&ownership=company`);
    expect(stock.body).toMatchObject({
      total: 1,
      items: [{ quantity: '20.0000', ownership: 'company' }],
    });
    const ledger = await get(`/inventory/ledger?storeId=${store}&movementType=receipt`);
    expect((ledger.body as Json).items[0]).toMatchObject({
      movementType: 'receipt',
      quantity: '20.0000',
    });
    expect((await get('/inventory/stock?ownership=other')).status).toBe(400);
    expect((await get('/inventory/ledger?movementType=nope')).status).toBe(400);
    expect((await get('/inventory/stock', NOBODY)).status).toBe(403);
    expect((await get('/inventory/ledger', NOBODY)).status).toBe(403);
    expect((await get('/inventory/stock', MANAGEMENT)).status).toBe(200);
  });

  it('reports integrity to those who manage stores and refuses others', async () => {
    const report = await get('/inventory/integrity', ADMIN);
    expect(report).toMatchObject({ status: 200, body: { differences: [] } });
    expect((await get('/inventory/integrity', ACCOUNTANT)).status).toBe(403);
  });

  it('shows the client material of a project', async () => {
    const { store, item } = await stocked();
    const received = await post('/inventory/client-receipts', {
      storeId: store,
      itemId: item,
      quantity: '9',
      ownerPartyId: kit.clientParty,
      projectId,
      businessDate: '2026-10-25',
    });
    expect(received.status).toBe(201);
    const rows = await get(`/inventory/client-material/${projectId}`);
    expect((rows.body as Json[]).find((r) => r.storeId === store)).toMatchObject({
      received: '9.0000',
      balance: '9.0000',
    });
    expect((await get('/inventory/client-material/not-a-uuid')).status).toBe(400);
  });
});

describe('movements', () => {
  it('issues stock, replays the retry and refuses bad requests', async () => {
    const { store, item } = await stocked();
    const key = newKey();
    const first = await call({
      method: 'POST',
      url: '/inventory/issues',
      body: issueBody(store, item),
      key,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ quantity: '2.0000', value: '20.00' });
    const again = await call({
      method: 'POST',
      url: '/inventory/issues',
      body: issueBody(store, item),
      key,
    });
    expect(again.body).toEqual(first.body);
    expect(await kit.stock(store, item)).toBe('18.0000');
    expect(
      errorCode(await post('/inventory/issues', issueBody(store, item, { quantity: '99' }))),
    ).toBe('insufficient_stock');
    expect(
      errorCode(await post('/inventory/issues', issueBody(store, item, { quantity: 'x' }))),
    ).toBe('validation_failed');
    expect(errorCode(await post('/inventory/issues', issueBody(MISSING, item)))).toBe(
      'store_not_found',
    );
    expect((await post('/inventory/issues', issueBody(store, item), NOBODY)).status).toBe(403);
    expect((await post('/inventory/issues', issueBody(store, item), ACCOUNTANT)).status).toBe(403);
  });

  it('returns stock to the store', async () => {
    const { store, item } = await stocked();
    const issue = await post('/inventory/issues', issueBody(store, item, { quantity: '5' }));
    const id = (issue.body as Json).id;
    const back = await post('/inventory/returns', {
      issueId: id,
      quantity: '2',
      businessDate: '2026-10-25',
    });
    expect(back).toMatchObject({ status: 201, body: { quantity: '2.0000', value: '20.00' } });
    expect(
      errorCode(
        await post('/inventory/returns', {
          issueId: id,
          quantity: '9',
          businessDate: '2026-10-25',
        }),
      ),
    ).toBe('return_exceeds_issue');
    expect(
      errorCode(
        await post('/inventory/returns', {
          issueId: MISSING,
          quantity: '1',
          businessDate: '2026-10-25',
        }),
      ),
    ).toBe('issue_not_found');
    expect(
      errorCode(await post('/inventory/returns', { issueId: id, businessDate: '2026-10-25' })),
    ).toBe('validation_failed');
    expect(
      (
        await post(
          '/inventory/returns',
          { issueId: id, quantity: '1', businessDate: '2026-10-25' },
          SUPERVISOR,
        )
      ).status,
    ).toBe(403);
  });

  it('takes client material in and out', async () => {
    const { store, item } = await stocked();
    const body = {
      storeId: store,
      itemId: item,
      quantity: '4',
      ownerPartyId: kit.clientParty,
      projectId,
      businessDate: '2026-10-25',
    };
    expect((await post('/inventory/client-receipts', body)).status).toBe(201);
    expect((await post('/inventory/client-returns', { ...body, quantity: '1' })).status).toBe(201);
    expect(errorCode(await post('/inventory/client-returns', { ...body, quantity: '40' }))).toBe(
      'insufficient_stock',
    );
    expect(
      errorCode(await post('/inventory/client-receipts', { ...body, ownerPartyId: 'x' })),
    ).toBe('validation_failed');
    expect((await post('/inventory/client-returns', body, SUPERVISOR)).status).toBe(403);
    expect((await post('/inventory/client-receipts', body, SUPERVISOR)).status).toBe(403);
  });

  it('takes salvage into stock', async () => {
    const { store, item } = await stocked();
    const body = {
      storeId: store,
      itemId: item,
      quantity: '3',
      projectId,
      businessDate: '2026-10-25',
    };
    expect(await post('/inventory/salvage', body)).toMatchObject({
      status: 201,
      body: { value: '0.00' },
    });
    expect(errorCode(await post('/inventory/salvage', { ...body, storeId: MISSING }))).toBe(
      'store_not_found',
    );
    expect((await post('/inventory/salvage', body, SUPERVISOR)).status).toBe(403);
    expect(errorCode(await post('/inventory/salvage', { ...body, quantity: '0' }))).toBe(
      'quantity_not_positive',
    );
  });
});

describe('transfers', () => {
  it('runs a transfer through send and receive and guards versions', async () => {
    const { store, item } = await stocked();
    const to = await kit.store();
    const created = await post('/inventory/transfers', {
      fromStoreId: store,
      toStoreId: to,
      businessDate: '2026-10-25',
      lines: [{ itemId: item, quantity: '5' }],
    });
    expect(created.status).toBe(201);
    const id = (created.body as Json).id;
    expect((await get(`/inventory/transfers/${id}`)).body).toMatchObject({ status: 'draft' });
    expect((await get('/inventory/transfers?status=draft')).body).toMatchObject({
      total: expect.any(Number),
    });
    expect(errorCode(await post(`/inventory/transfers/${id}/send`, { version: 9 }))).toBe(
      'version_conflict',
    );
    const sent = await post(`/inventory/transfers/${id}/send`, { version: 1 });
    expect(sent.body).toMatchObject({ status: 'in_transit', version: 2 });
    const received = await post(`/inventory/transfers/${id}/receive`, { version: 2 });
    expect(received.body).toMatchObject({ status: 'received' });
    expect(errorCode(await post(`/inventory/transfers/${id}/cancel`, { version: 3 }))).toBe(
      'transfer_transition',
    );
    expect(errorCode(await post(`/inventory/transfers/${MISSING}/send`, { version: 1 }))).toBe(
      'transfer_not_found',
    );
    expect((await get(`/inventory/transfers/${MISSING}`)).status).toBe(404);
    expect(errorCode(await post(`/inventory/transfers/${id}/send`, {}))).toBe('validation_failed');
    expect((await post(`/inventory/transfers/${id}/send`, { version: 1 }, SUPERVISOR)).status).toBe(
      403,
    );
    expect(
      errorCode(
        await post('/inventory/transfers', {
          fromStoreId: store,
          toStoreId: to,
          businessDate: '2026-10-25',
          lines: [],
        }),
      ),
    ).toBe('validation_failed');
    const second = await post('/inventory/transfers', {
      fromStoreId: store,
      toStoreId: to,
      businessDate: '2026-10-25',
      lines: [{ itemId: item, quantity: '1' }],
    });
    const cancelled = await post(`/inventory/transfers/${(second.body as Json).id}/cancel`, {
      version: 1,
    });
    expect(cancelled.body).toMatchObject({ status: 'cancelled' });
    expect((await post('/inventory/transfers', {}, SUPERVISOR)).status).toBe(403);
  });
});

describe('counts', () => {
  it('creates, submits and cancels a count', async () => {
    await kit.setting('inventory.stock_loss_cost_code', kit.codes['100'] as string);
    const { store, item } = await stocked();
    const body = {
      storeId: store,
      countedOn: '2026-10-25',
      lines: [{ itemId: item, countedQty: '18' }],
    };
    const created = await post('/inventory/counts', body);
    expect(created.status).toBe(201);
    const id = (created.body as Json).id;
    expect((await get(`/inventory/counts/${id}`)).body).toMatchObject({
      status: 'draft',
      lines: [{ systemQty: '20.0000', countedQty: '18.0000' }],
    });
    expect((await get('/inventory/counts?status=draft')).status).toBe(200);
    expect(errorCode(await post(`/inventory/counts/${id}/submit`, { version: 9 }))).toBe(
      'version_conflict',
    );
    expect((await post(`/inventory/counts/${id}/submit`, { version: 1 })).body).toMatchObject({
      status: 'counted',
    });
    await kit.decide('stock_adjustment', id, 'approve');
    expect(await kit.stock(store, item)).toBe('18.0000');
    const other = await post('/inventory/counts', body);
    expect(
      (await post(`/inventory/counts/${(other.body as Json).id}/cancel`, { version: 1 })).body,
    ).toMatchObject({ status: 'cancelled' });
    expect(errorCode(await post(`/inventory/counts/${MISSING}/submit`, { version: 1 }))).toBe(
      'count_not_found',
    );
    expect((await get(`/inventory/counts/${MISSING}`)).status).toBe(404);
    expect(errorCode(await post('/inventory/counts', { ...body, lines: [] }))).toBe(
      'validation_failed',
    );
    expect((await post('/inventory/counts', body, SUPERVISOR)).status).toBe(403);
    expect((await post(`/inventory/counts/${id}/cancel`, { version: 1 }, SUPERVISOR)).status).toBe(
      403,
    );
  });
});
