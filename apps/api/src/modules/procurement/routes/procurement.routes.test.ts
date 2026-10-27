/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
   These tests read untyped JSON bodies of the HTTP API. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MANAGEMENT,
  MISSING,
  NOBODY,
  PDF_BYTES,
  PROCUREMENT,
  STORE,
  STOREKEEPER,
  SUPERVISOR,
  createProcurementKit,
  type ProcurementKit,
} from '../test-support.js';

vi.setConfig({ testTimeout: 60_000 });

let kit: ProcurementKit;
let projectId: string;
beforeAll(async () => {
  kit = await createProcurementKit();
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

const call = async ({ method, url, user = PROCUREMENT, body, key }: Call) => {
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
const newKey = () => `prc-key-${++keyCounter}`;
const post = (url: string, body: unknown, user = PROCUREMENT) =>
  call({ method: 'POST', url, user, body, key: newKey() });
const put = (url: string, body: unknown, user = PROCUREMENT) =>
  call({ method: 'PUT', url, user, body, key: newKey() });
const get = (url: string, user = PROCUREMENT) => call({ method: 'GET', url, user });

type Json = Record<string, any>;

const reqBody = async (over: Json = {}) => ({
  storeId: STORE,
  requiredBy: '2026-11-10',
  note: 'Cement',
  lines: [
    {
      itemId: await kit.item(),
      quantity: '100',
      costCodeId: kit.codes['100'],
      estimatedRate: '1200',
    },
  ],
  ...over,
});
const poBody = async (over: Json = {}) => ({
  vendorId: await kit.vendor(),
  projectId,
  orderDate: '2026-10-25',
  expectedDate: '2026-11-01',
  terms: 'Net 30',
  lines: [
    { itemId: await kit.item(), quantity: '10', rate: '100.5', costCodeId: kit.codes['100'] },
  ],
  ...over,
});

describe('requisition endpoints', () => {
  it('creates once for a repeated Idempotency-Key and refuses a changed body', async () => {
    const payload = await reqBody();
    const key = newKey();
    const first = await call({
      method: 'POST',
      url: '/procurement/requisitions',
      body: payload,
      key,
    });
    const second = await call({
      method: 'POST',
      url: '/procurement/requisitions',
      body: payload,
      key,
    });
    expect(first.status).toBe(201);
    expect((second.body as Json).id).toBe((first.body as Json).id);
    const changed = await call({
      method: 'POST',
      url: '/procurement/requisitions',
      body: { ...payload, note: 'Other' },
      key,
    });
    expect(changed.status).toBe(422);
    const empty = await call({
      method: 'POST',
      url: '/procurement/requisitions',
      body: payload,
      key: '',
    });
    expect(errorCode(empty)).toBe('invalid_idempotency_key');
  });

  it('validates the body and the permission', async () => {
    const bad = [
      await reqBody({ lines: [] }),
      await reqBody({ requiredBy: '10/11/2026' }),
      await reqBody({ storeId: 'x' }),
    ];
    for (const payload of bad) {
      expect((await post('/procurement/requisitions', payload)).status).toBe(400);
    }
    expect(
      errorCode(await post('/procurement/requisitions', await reqBody({ storeId: undefined }))),
    ).toBe('destination_required');
    for (const user of [NOBODY, MANAGEMENT]) {
      expect((await post('/procurement/requisitions', await reqBody(), user)).status).toBe(403);
    }
    expect((await post('/procurement/requisitions', await reqBody(), STOREKEEPER)).status).toBe(
      201,
    );
  });

  it('reads, lists, updates, submits and cancels', async () => {
    const created = (await post('/procurement/requisitions', await reqBody())).body as Json;
    const url = `/procurement/requisitions/${created.id}`;
    for (const user of [PROCUREMENT, MANAGEMENT]) {
      expect((await get(url, user)).status).toBe(200);
    }
    expect((await get(url, NOBODY)).status).toBe(403);
    expect((await get(`/procurement/requisitions/${MISSING}`)).status).toBe(404);
    expect((await get('/procurement/requisitions/not-a-uuid')).status).toBe(400);
    const listed = await get(`/procurement/requisitions?status=draft&limit=5`);
    expect((listed.body as Json).items.length).toBeGreaterThan(0);
    expect((await get('/procurement/requisitions?status=bogus')).status).toBe(400);

    const stale = await put(url, { ...(await reqBody()), version: 9 });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
    const updated = await put(url, {
      ...(await reqBody({ note: 'Changed' })),
      version: created.version,
    });
    expect(updated.status).toBe(200);
    expect((updated.body as Json).note).toBe('Changed');
    expect(
      (await put(`/procurement/requisitions/${MISSING}`, { ...(await reqBody()), version: 1 }))
        .status,
    ).toBe(404);

    expect((await post(`${url}/submit`, { version: 1 })).status).toBe(409);
    const submitted = await post(`${url}/submit`, { version: (updated.body as Json).version });
    expect((submitted.body as Json).status).toBe('pending_approval');
    expect((await post(`${url}/submit`, {})).status).toBe(400);
    const cancelled = await post(`${url}/cancel`, { version: (submitted.body as Json).version });
    expect((cancelled.body as Json).status).toBe('cancelled');
    expect((await post(`${url}/cancel`, { version: 1 }, NOBODY)).status).toBe(403);
  });

  it('keeps a supervisor to the assigned projects', async () => {
    await kit.assignSupervisor(projectId, SUPERVISOR);
    const mine = await post(
      '/procurement/requisitions',
      await reqBody({ storeId: undefined, projectId }),
      SUPERVISOR,
    );
    expect(mine.status).toBe(201);
    const other = await kit.project();
    const refused = await post(
      '/procurement/requisitions',
      await reqBody({ storeId: undefined, projectId: other.id }),
      SUPERVISOR,
    );
    expect(refused.status).toBe(404);
    const theirs = (
      await post(
        '/procurement/requisitions',
        await reqBody({ storeId: undefined, projectId: other.id }),
      )
    ).body as Json;
    expect((await get(`/procurement/requisitions/${theirs.id}`, SUPERVISOR)).status).toBe(404);
    const listed = (await get('/procurement/requisitions', SUPERVISOR)).body as Json;
    expect(listed.items.map((r: Json) => r.id)).toEqual([(mine.body as Json).id]);
  });
});

describe('RFQ and quote endpoints', () => {
  it('runs the quotation round', async () => {
    const requisition = await kit.approvedRequisition();
    const lines = ((await get(`/procurement/requisitions/${requisition}`)).body as Json)
      .lines as Json[];
    const [vendorA, vendorB] = [await kit.vendor(), await kit.vendor()];
    const bad = await post('/procurement/rfqs', { requisitionId: requisition, vendorIds: [] });
    expect(bad.status).toBe(400);
    expect(
      (
        await post(
          '/procurement/rfqs',
          { requisitionId: requisition, vendorIds: [vendorA] },
          STOREKEEPER,
        )
      ).status,
    ).toBe(403);
    const rfq = (
      await post('/procurement/rfqs', { requisitionId: requisition, vendorIds: [vendorA, vendorB] })
    ).body as Json;
    expect(rfq.status).toBe('open');
    expect((await get(`/procurement/rfqs/${rfq.id}`)).status).toBe(200);
    expect((await get(`/procurement/rfqs/${MISSING}`)).status).toBe(404);
    expect(
      ((await get(`/procurement/rfqs?requisitionId=${requisition}`)).body as Json).items,
    ).toHaveLength(1);
    expect((await get(`/procurement/rfqs`, NOBODY)).status).toBe(403);

    const quoteBody = (vendorId: string, rate: string) => ({
      rfqId: rfq.id,
      vendorId,
      validUntil: '2026-11-30',
      deliveryDays: 3,
      terms: 'Ex-works',
      lines: [{ requisitionLineId: lines[0]!.id, rate }],
    });
    expect(
      (await post('/procurement/quotes', { ...quoteBody(vendorA, '1'), lines: [] })).status,
    ).toBe(400);
    expect((await post('/procurement/quotes', quoteBody(vendorA, '1'), NOBODY)).status).toBe(403);
    const qa = (await post('/procurement/quotes', quoteBody(vendorA, '1100'))).body as Json;
    const qb = (await post('/procurement/quotes', quoteBody(vendorB, '1000'))).body as Json;
    expect((await get(`/procurement/quotes/${qa.id}`)).status).toBe(200);
    expect((await get(`/procurement/quotes/${MISSING}`)).status).toBe(404);
    const stale = await put(`/procurement/quotes/${qa.id}`, {
      ...quoteBody(vendorA, '1050'),
      version: 9,
    });
    expect(stale.status).toBe(409);
    const updated = await put(`/procurement/quotes/${qa.id}`, {
      ...quoteBody(vendorA, '1050'),
      version: qa.version,
    });
    expect((updated.body as Json).total).toBe('105000.00');

    const select = (quoteId: string, reason?: string) =>
      post(`/procurement/rfqs/${rfq.id}/select-vendor`, {
        requisitionLineId: lines[0]!.id,
        quoteId,
        reason,
      });
    expect(errorCode(await select(qa.id))).toBe('selection_reason_required');
    expect((await select(qa.id, 'Closer to site')).status).toBe(200);
    expect((await select(qb.id)).status).toBe(200);
    expect((await post(`/procurement/rfqs/${rfq.id}/select-vendor`, {})).status).toBe(400);

    expect((await post(`/procurement/rfqs/${rfq.id}/close`, { version: 9 })).status).toBe(409);
    expect(
      ((await post(`/procurement/rfqs/${rfq.id}/close`, { version: rfq.version })).body as Json)
        .status,
    ).toBe('closed');
  });
});

describe('purchase order endpoints', () => {
  it('creates, edits, submits and prints', async () => {
    const payload = await poBody();
    const key = newKey();
    const first = await call({
      method: 'POST',
      url: '/procurement/purchase-orders',
      body: payload,
      key,
    });
    const second = await call({
      method: 'POST',
      url: '/procurement/purchase-orders',
      body: payload,
      key,
    });
    expect(first.status).toBe(201);
    expect((second.body as Json).id).toBe((first.body as Json).id);
    const po = first.body as Json;
    expect(po.total).toBe('1005.00');

    for (const bad of [
      await poBody({ lines: [] }),
      await poBody({ orderDate: 'x' }),
      await poBody({ vendorId: 'x' }),
    ]) {
      expect((await post('/procurement/purchase-orders', bad)).status).toBe(400);
    }
    for (const user of [NOBODY, MANAGEMENT, SUPERVISOR]) {
      expect((await post('/procurement/purchase-orders', await poBody(), user)).status).toBe(403);
    }
    expect(
      errorCode(await post('/procurement/purchase-orders', await poBody({ projectId: undefined }))),
    ).toBe('destination_required');

    const url = `/procurement/purchase-orders/${po.id}`;
    for (const user of [PROCUREMENT, MANAGEMENT]) {
      expect((await get(url, user)).status).toBe(200);
      expect((await get(`/procurement/po/${po.id}/print-model`, user)).status).toBe(200);
    }
    expect((await get(url, STOREKEEPER)).status).toBe(403);
    expect((await get(`/procurement/purchase-orders/${MISSING}`)).status).toBe(404);
    expect((await get(`/procurement/po/${MISSING}/print-model`)).status).toBe(404);
    expect(
      ((await get(`/procurement/purchase-orders?status=draft&projectId=${projectId}`)).body as Json)
        .total,
    ).toBeGreaterThan(0);
    expect((await get('/procurement/purchase-orders?status=bogus')).status).toBe(400);

    const stale = await put(url, { ...(await poBody()), version: 9 });
    expect(stale.status).toBe(409);
    const updated = await put(url, { ...payload, terms: 'Net 45', version: po.version });
    expect((updated.body as Json).terms).toBe('Net 45');
    expect(
      (await put(`/procurement/purchase-orders/${MISSING}`, { ...payload, version: 1 })).status,
    ).toBe(404);

    const submitted = await post(`${url}/submit`, { version: (updated.body as Json).version });
    expect((submitted.body as Json).status).toBe('pending_approval');
    expect((await post(`${url}/submit`, { version: 1 })).status).toBe(409);
    expect((await post(`${url}/cancel`, { version: 1 }, STOREKEEPER)).status).toBe(403);
    const cancelled = await post(`${url}/cancel`, { version: (submitted.body as Json).version });
    expect((cancelled.body as Json).status).toBe('cancelled');
    expect((await post(`${url}/close`, {})).status).toBe(400);
  });

  it('amends and closes an approved order, and lists open lines', async () => {
    const id = await kit.approvedPo(projectId);
    const po = (await get(`/procurement/purchase-orders/${id}`)).body as Json;
    const amendBody = {
      vendorId: po.vendorId,
      projectId,
      orderDate: po.orderDate,
      version: po.version,
      lines: po.lines.map((l: Json) => ({
        lineId: l.id,
        itemId: l.itemId,
        quantity: l.quantity,
        rate: l.rate,
        costCodeId: l.costCodeId,
      })),
    };
    expect(
      (await post(`/procurement/purchase-orders/${id}/amend`, amendBody, SUPERVISOR)).status,
    ).toBe(403);
    expect(
      (await post(`/procurement/purchase-orders/${id}/amend`, { ...amendBody, version: 9 })).status,
    ).toBe(409);
    const amended = await post(`/procurement/purchase-orders/${id}/amend`, amendBody);
    expect(amended.status).toBe(200);
    expect((amended.body as Json).revision).toBe(2);
    const reapproved = await post(`/procurement/purchase-orders/${id}/submit`, {
      version: (amended.body as Json).version,
    });
    expect(reapproved.status).toBe(200);
    await kit.decide('purchase_order', id, 'approve');

    const open = (await get(`/procurement/open-po-lines?projectId=${projectId}`)).body as Json[];
    expect(open.length).toBeGreaterThanOrEqual(2);
    expect((await get('/procurement/open-po-lines', STOREKEEPER)).status).toBe(403);
    const version = ((await get(`/procurement/purchase-orders/${id}`)).body as Json).version;
    const closed = await post(`/procurement/purchase-orders/${id}/close`, { version });
    expect((closed.body as Json).status).toBe('closed');
  });

  it('creates an order from the selected quotes', async () => {
    const requisition = await kit.approvedRequisition();
    const lines = ((await get(`/procurement/requisitions/${requisition}`)).body as Json)
      .lines as Json[];
    const vendor = await kit.vendor();
    const rfq = (
      await post('/procurement/rfqs', { requisitionId: requisition, vendorIds: [vendor] })
    ).body as Json;
    const quote = (
      await post('/procurement/quotes', {
        rfqId: rfq.id,
        vendorId: vendor,
        lines: lines.map((l) => ({ requisitionLineId: l.id, rate: '10' })),
      })
    ).body as Json;
    for (const line of lines) {
      await post(`/procurement/rfqs/${rfq.id}/select-vendor`, {
        requisitionLineId: line.id,
        quoteId: quote.id,
      });
    }
    const body = { rfqId: rfq.id, vendorId: vendor, orderDate: '2026-10-25' };
    expect(
      (await post('/procurement/purchase-orders/from-rfq', { ...body, orderDate: 'x' })).status,
    ).toBe(400);
    expect((await post('/procurement/purchase-orders/from-rfq', body, NOBODY)).status).toBe(403);
    const made = await post('/procurement/purchase-orders/from-rfq', body);
    expect(made.status).toBe(201);
    expect((made.body as Json).requisitionId).toBe(requisition);
    expect(errorCode(await post('/procurement/purchase-orders/from-rfq', body))).toBe(
      'requisition_not_approved',
    );
    expect(
      errorCode(await post('/procurement/purchase-orders/from-rfq', { ...body, rfqId: MISSING })),
    ).toBe('rfq_not_found');
  });
});

describe('goods receipt endpoints', () => {
  const grnBody = (po: Json, over: Json = {}) => ({
    poId: po.id,
    receivedOn: '2026-10-26',
    deliveryNoteRef: 'DC-9',
    lines: [{ poLineId: po.lines[0].id, acceptedQty: '4', rejectedQty: '1', note: 'one cracked' }],
    photos: [{ fileName: 'challan.pdf', contentBase64: Buffer.from(PDF_BYTES).toString('base64') }],
    ...over,
  });

  it('receives with the photo, replays safely and refuses bad input', async () => {
    const id = await kit.approvedPo(projectId);
    const po = (await get(`/procurement/purchase-orders/${id}`)).body as Json;
    const payload = grnBody(po);
    const key = newKey();
    const first = await call({
      method: 'POST',
      url: '/procurement/grns',
      user: STOREKEEPER,
      body: payload,
      key,
    });
    const second = await call({
      method: 'POST',
      url: '/procurement/grns',
      user: STOREKEEPER,
      body: payload,
      key,
    });
    expect(first.status).toBe(201);
    expect((second.body as Json).id).toBe((first.body as Json).id);
    expect((first.body as Json).lines[0].costAmount).toBe('5002.00');

    expect((await post('/procurement/grns', grnBody(po, { lines: [] }), STOREKEEPER)).status).toBe(
      400,
    );
    expect(
      (await post('/procurement/grns', grnBody(po, { receivedOn: 'x' }), STOREKEEPER)).status,
    ).toBe(400);
    expect((await post('/procurement/grns', grnBody(po), MANAGEMENT)).status).toBe(403);
    expect(
      errorCode(await post('/procurement/grns', grnBody(po, { photos: [] }), STOREKEEPER)),
    ).toBe('grn_photo_required');
    expect(
      errorCode(
        await post(
          '/procurement/grns',
          grnBody(po, { lines: [{ poLineId: po.lines[0].id, acceptedQty: '999' }] }),
          STOREKEEPER,
        ),
      ),
    ).toBe('over_receipt');
    expect(
      errorCode(await post('/procurement/grns', grnBody(po, { poId: MISSING }), STOREKEEPER)),
    ).toBe('purchase_order_not_found');
  });

  it('reads, lists and cancels', async () => {
    const id = await kit.approvedPo(projectId);
    const po = (await get(`/procurement/purchase-orders/${id}`)).body as Json;
    const grn = (await post('/procurement/grns', grnBody(po), STOREKEEPER)).body as Json;
    const url = `/procurement/grns/${grn.id}`;
    for (const user of [STOREKEEPER, PROCUREMENT, MANAGEMENT]) {
      expect((await get(url, user)).status).toBe(200);
    }
    expect((await get(url, NOBODY)).status).toBe(403);
    expect((await get(`/procurement/grns/${MISSING}`, STOREKEEPER)).status).toBe(404);
    expect(
      ((await get(`/procurement/grns?poId=${id}&status=posted`, STOREKEEPER)).body as Json).total,
    ).toBe(1);
    expect((await get('/procurement/grns?status=bogus', STOREKEEPER)).status).toBe(400);

    expect((await post(`${url}/cancel`, { version: 1 }, STOREKEEPER)).status).toBe(400);
    expect(
      (await post(`${url}/cancel`, { version: 9, reason: 'Mistake' }, STOREKEEPER)).status,
    ).toBe(409);
    expect(
      (await post(`${url}/cancel`, { version: 1, reason: 'Mistake' }, PROCUREMENT)).status,
    ).toBe(403);
    const cancelled = await post(
      `${url}/cancel`,
      { version: grn.version, reason: 'Mistake' },
      STOREKEEPER,
    );
    expect((cancelled.body as Json).status).toBe('cancelled');
    expect(
      (await post(`/procurement/grns/${MISSING}/cancel`, { version: 1, reason: 'x' }, STOREKEEPER))
        .status,
    ).toBe(404);
  });

  it('keeps a supervisor to the assigned projects', async () => {
    await kit.assignSupervisor(projectId, SUPERVISOR);
    const mine = (await get(`/procurement/purchase-orders/${await kit.approvedPo(projectId)}`))
      .body as Json;
    const other = await kit.project();
    const theirs = (await get(`/procurement/purchase-orders/${await kit.approvedPo(other.id)}`))
      .body as Json;
    expect((await post('/procurement/grns', grnBody(mine), SUPERVISOR)).status).toBe(201);
    expect((await post('/procurement/grns', grnBody(theirs), SUPERVISOR)).status).toBe(404);
  });
});
