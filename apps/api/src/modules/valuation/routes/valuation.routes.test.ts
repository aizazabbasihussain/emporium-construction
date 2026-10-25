import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  CAT_STEEL,
  createValuationKit,
  ITEM_STEEL,
  MANAGEMENT,
  NOBODY,
  STOREKEEPER,
  STORE_A,
  TODAY,
  TOMORROW,
  type ValuationKit,
} from '../test-support.js';

let kit: ValuationKit;
beforeAll(async () => {
  kit = await createValuationKit();
  await kit.tx((tx) =>
    kit.valuation.recordReceipt(
      {
        storeId: STORE_A,
        itemId: ITEM_STEEL,
        quantity: '3',
        unitCost: '10',
        postingDate: TODAY,
        idempotencyKey: kit.key(),
      },
      kit.actor,
      tx,
    ),
  );
}, 60_000);
afterAll(() => kit.close());

interface Json {
  items: unknown[];
  [key: string]: unknown;
}

interface Call {
  method: 'GET' | 'POST';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = ACCOUNTANT, body, key }: Call) => {
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
    body: response.body === '' ? null : response.json<Json>(),
  };
};
const errorCode = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

describe('GET /valuation/policies', () => {
  it('lists the policies for anyone with policy.read', async () => {
    for (const user of [ACCOUNTANT, MANAGEMENT, STOREKEEPER, ADMIN]) {
      const response = await call({ method: 'GET', url: '/valuation/policies', user });
      expect(response.status).toBe(200);
      expect(response.body?.items[0]).toMatchObject({ scope: 'company', status: 'active' });
    }
    const pending = await call({
      method: 'GET',
      url: '/valuation/policies?status=pending_approval',
    });
    expect(pending.body?.items).toEqual([]);
  });

  it('rejects a bad filter and a caller without the permission', async () => {
    expect((await call({ method: 'GET', url: '/valuation/policies?status=nope' })).status).toBe(
      400,
    );
    expect((await call({ method: 'GET', url: '/valuation/policies', user: NOBODY })).status).toBe(
      403,
    );
  });
});

describe('POST /valuation/policies', () => {
  const body = {
    scope: 'category',
    categoryId: CAT_STEEL,
    method: 'fifo',
    effectiveFrom: TOMORROW,
  };

  it('requests a policy change (accountant) and replays an idempotent retry', async () => {
    const first = await call({ method: 'POST', url: '/valuation/policies', body, key: 'policy-1' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'pending_approval',
      method: 'fifo',
      categoryId: CAT_STEEL,
    });
    const retry = await call({ method: 'POST', url: '/valuation/policies', body, key: 'policy-1' });
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    const list = await call({ method: 'GET', url: '/valuation/policies?status=pending_approval' });
    expect(list.body?.items).toHaveLength(1);
  });

  it('refuses invalid input, back-dating, an unknown category and other roles', async () => {
    const post = (payload: unknown, user = ACCOUNTANT) =>
      call({ method: 'POST', url: '/valuation/policies', body: payload, user });
    expect((await post({ ...body, method: 'lifo' })).status).toBe(400);
    expect((await post({ ...body, effectiveFrom: 'tomorrow' })).status).toBe(400);
    expect((await post({ ...body, categoryId: 'not-a-uuid' })).status).toBe(400);
    const past = await post({ scope: 'company', method: 'fifo', effectiveFrom: '2026-10-24' });
    expect(past.status).toBe(422);
    expect(errorCode(past)).toBe('policy_back_dated');
    const missing = await post({ ...body, categoryId: '018f7a7a-3333-7000-8000-000000009998' });
    expect(missing.status).toBe(404);
    expect((await post(body, STOREKEEPER)).status).toBe(403);
    expect((await post(body, MANAGEMENT)).status).toBe(403);
  });

  it('rejects a malformed Idempotency-Key header', async () => {
    const response = await kit.app.inject({
      method: 'POST',
      url: '/valuation/policies',
      headers: { ...(await kit.auth(ACCOUNTANT)), 'idempotency-key': '' },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /valuation/transitions/run', () => {
  it('runs the transitions (accountant, admin) and replays a retry', async () => {
    const first = await call({ method: 'POST', url: '/valuation/transitions/run', key: 'run-1' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ items: [] });
    const retry = await call({ method: 'POST', url: '/valuation/transitions/run', key: 'run-1' });
    expect(retry.body).toEqual(first.body);
    const byAdmin = await call({ method: 'POST', url: '/valuation/transitions/run', user: ADMIN });
    expect(byAdmin.status).toBe(200);
  });

  it('is denied to everyone else', async () => {
    for (const user of [MANAGEMENT, STOREKEEPER, NOBODY]) {
      const response = await call({ method: 'POST', url: '/valuation/transitions/run', user });
      expect(response.status).toBe(403);
    }
  });
});

describe('reports', () => {
  it('GET /valuation/stock-value returns the value per key and filters', async () => {
    const all = await call({ method: 'GET', url: '/valuation/stock-value' });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ totalValue: '30.00' });
    expect(all.body?.items[0]).toMatchObject({
      storeId: STORE_A,
      itemId: ITEM_STEEL,
      quantity: '3.0000',
    });
    const filtered = await call({
      method: 'GET',
      url: `/valuation/stock-value?store=${STORE_A}&item=${ITEM_STEEL}&category=${CAT_STEEL}`,
      user: MANAGEMENT,
    });
    expect(filtered.body?.items).toHaveLength(1);
    expect((await call({ method: 'GET', url: '/valuation/stock-value?store=nope' })).status).toBe(
      400,
    );
    const denied = await call({ method: 'GET', url: '/valuation/stock-value', user: STOREKEEPER });
    expect(denied.status).toBe(403);
  });

  it('GET /valuation/movements pages and filters', async () => {
    const page = await call({
      method: 'GET',
      url: `/valuation/movements?store=${STORE_A}&type=receipt&limit=5`,
    });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total: 1, limit: 5, offset: 0 });
    expect(page.body?.items[0]).toMatchObject({ type: 'receipt', value: '30.00' });
    expect((await call({ method: 'GET', url: '/valuation/movements?type=bogus' })).status).toBe(
      400,
    );
    expect((await call({ method: 'GET', url: '/valuation/movements?limit=0' })).status).toBe(400);
    expect((await call({ method: 'GET', url: '/valuation/movements', user: NOBODY })).status).toBe(
      403,
    );
  });

  it('GET /valuation/transitions pages the log', async () => {
    const log = await call({ method: 'GET', url: '/valuation/transitions?limit=10' });
    expect(log.status).toBe(200);
    expect(log.body).toEqual({ items: [], total: 0, limit: 10, offset: 0 });
    const denied = await call({ method: 'GET', url: '/valuation/transitions', user: STOREKEEPER });
    expect(denied.status).toBe(403);
    expect((await call({ method: 'GET', url: '/valuation/transitions?offset=-1' })).status).toBe(
      400,
    );
  });
});
