import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  MANAGEMENT,
  NOBODY,
  PM,
  PM2,
  SUPERVISOR,
  TODAY,
  createSubcontractsKit,
  type SubcontractsKit,
} from '../test-support.js';

let kit: SubcontractsKit;
beforeAll(async () => {
  kit = await createSubcontractsKit();
}, 180_000);
afterAll(() => kit.close());

const MISSING = '018f7c7c-0000-7000-8000-00000000dead';

/** The fields of the answers these tests read. */
interface Doc {
  id: string;
  version: number;
  status: string;
  title: string;
  amount: string;
  total: number;
  committedAmount: string | null;
  items: { id: string; contractAmount: unknown }[];
  variations: unknown[];
  orders: unknown[];
  bill: unknown;
}

interface Reply {
  status: number;
  body: Doc;
}

async function call(
  user: string | null,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await kit.sapp.inject({
    method,
    url,
    headers: { ...(user === null ? {} : await kit.auth(user)), ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return {
    status: response.statusCode,
    body: response.body === '' ? ({} as Doc) : response.json<Doc>(),
  };
}

const orderBody = (over: Record<string, unknown> = {}) => ({
  projectId: MISSING,
  partyId: MISSING,
  title: 'Plaster',
  contractAmount: '1000000',
  costCodeId: MISSING,
  ...over,
});
const certificateBody = (over: Record<string, unknown> = {}) => ({
  certificateDate: TODAY,
  basis: 'percent_complete',
  cumulativePercent: '30',
  ...over,
});

describe('the subcontracts endpoints over HTTP', () => {
  it('walks an order from draft to a billed certificate and its ledger (AC-1)', async () => {
    const project = await kit.locatedProject();
    const partyId = await kit.contractor();
    const created = await call(
      PM,
      'POST',
      '/subcontracts/work-orders',
      kit.orderInput(project.id, partyId),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', contractAmount: '1000000.00' });
    const id = created.body.id;
    const edited = await call(PM, 'PUT', `/subcontracts/work-orders/${id}`, {
      ...kit.orderInput(project.id, partyId, { title: 'Plaster and paint' }),
      version: created.body.version,
    });
    expect(edited).toMatchObject({ status: 200, body: { title: 'Plaster and paint' } });
    const stale = await call(PM, 'PUT', `/subcontracts/work-orders/${id}`, {
      ...kit.orderInput(project.id, partyId),
      version: created.body.version,
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await call(PM, 'POST', `/subcontracts/work-orders/${id}/submit`, {
          version: edited.body.version,
        })
      ).status,
    ).toBe(200);
    await kit.decide('subcontract_order', id, 'approve');
    const listed = await call(
      PM,
      'GET',
      `/subcontracts/work-orders?projectId=${project.id}&status=active`,
    );
    expect(listed.body.items.map((o: { id: string }) => o.id)).toEqual([id]);
    expect((await call(PM, 'GET', `/subcontracts/work-orders/${id}`)).body.committedAmount).toBe(
      '1000000.00',
    );

    // Variations: proposed by the project manager, decided by the owner.
    const variation = await call(PM, 'POST', `/subcontracts/work-orders/${id}/variations`, {
      amount: '100000',
      reason: 'Extra',
    });
    expect(variation.status).toBe(201);
    const changed = await call(PM, 'PUT', `/subcontracts/variations/${variation.body.id}`, {
      amount: '120000',
      reason: 'Extra length',
      version: variation.body.version,
    });
    expect(changed.body.amount).toBe('120000.00');
    expect(
      (
        await call(PM, 'POST', `/subcontracts/variations/${variation.body.id}/approve`, {
          version: changed.body.version,
        })
      ).status,
    ).toBe(403);
    const approved = await call(
      MANAGEMENT,
      'POST',
      `/subcontracts/variations/${variation.body.id}/approve`,
      { version: changed.body.version, note: 'ok' },
    );
    expect(approved.body.status).toBe('approved');
    const second = await call(PM, 'POST', `/subcontracts/work-orders/${id}/variations`, {
      amount: '-10',
      reason: 'Less',
    });
    const rejected = await call(
      MANAGEMENT,
      'POST',
      `/subcontracts/variations/${second.body.id}/reject`,
      { version: second.body.version },
    );
    expect(rejected.body.status).toBe('rejected');

    // A certificate with a back-charge, certified by the second project manager.
    const certificate = await call(
      PM,
      'POST',
      `/subcontracts/work-orders/${id}/certificates`,
      certificateBody(),
    );
    expect(certificate.status).toBe(201);
    const cid = certificate.body.id;
    const charge = await call(PM, 'POST', `/subcontracts/work-orders/${id}/back-charges`, {
      description: 'Rework',
      amount: '5000',
      certificateId: cid,
    });
    expect(charge.status).toBe(201);
    const chargeEdited = await call(PM, 'PUT', `/subcontracts/back-charges/${charge.body.id}`, {
      description: 'Rework',
      amount: '6000',
      certificateId: cid,
      version: charge.body.version,
    });
    expect(chargeEdited.body.amount).toBe('6000.00');
    const charges = await call(PM, 'GET', `/subcontracts/work-orders/${id}/back-charges`);
    expect(charges.body).toHaveLength(1);
    const extra = await call(PM, 'POST', `/subcontracts/work-orders/${id}/back-charges`, {
      description: 'Temp',
      amount: '1',
    });
    expect(
      (
        await call(
          PM,
          'DELETE',
          `/subcontracts/back-charges/${extra.body.id}?version=${extra.body.version}`,
        )
      ).status,
    ).toBe(204);
    const updated = await call(PM, 'PUT', `/subcontracts/certificates/${cid}`, {
      ...certificateBody({ cumulativePercent: '40' }),
      version: (await call(PM, 'GET', `/subcontracts/certificates/${cid}`)).body.version,
    });
    expect(updated.body).toMatchObject({ cumulativePercent: '40.0000', deductions: '6000.00' });
    expect(
      (await call(PM, 'GET', `/subcontracts/work-orders/${id}/certificates`)).body,
    ).toHaveLength(1);
    expect(
      (
        await call(PM, 'POST', `/subcontracts/certificates/${cid}/submit`, {
          version: updated.body.version,
        })
      ).status,
    ).toBe(200);
    await kit.decideAs('subcontract_certificate', cid, PM2, 'project_manager');
    expect((await call(PM, 'GET', `/subcontracts/certificates/${cid}`)).body.status).toBe(
      'certified',
    );

    // The accountant bills it; the ledger and the statement show it.
    const bill = await call(ACCOUNTANT, 'POST', `/subcontracts/certificates/${cid}/bill`, {
      vendorInvoiceNo: 'HTTP-1',
      billDate: TODAY,
      dueDate: '2026-11-25',
    });
    expect(bill.status).toBe(201);
    expect(bill.body.bill).toMatchObject({ sourceType: 'subcontract' });
    const ledger = await call(ACCOUNTANT, 'GET', `/subcontracts/work-orders/${id}/ledger`);
    expect(ledger).toMatchObject({
      status: 200,
      body: { contract: '1120000.00', certified: '448000.00' },
    });
    const statement = await call(
      MANAGEMENT,
      'GET',
      `/subcontracts/subcontractors/${partyId}/statement`,
    );
    expect(statement.body.orders).toHaveLength(1);

    // Closing before the contract is fully certified needs a reason; cancelling another order works.
    const current = (await call(PM, 'GET', `/subcontracts/work-orders/${id}`)).body;
    expect(
      (
        await call(PM, 'POST', `/subcontracts/work-orders/${id}/close`, {
          version: current.version,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(PM, 'POST', `/subcontracts/work-orders/${id}/close`, {
          version: current.version,
          reason: 'Left',
        })
      ).body.status,
    ).toBe('closed');
    const other = await call(
      PM,
      'POST',
      '/subcontracts/work-orders',
      kit.orderInput(project.id, partyId),
    );
    expect(
      (
        await call(PM, 'POST', `/subcontracts/work-orders/${other.body.id}/cancel`, {
          version: other.body.version,
        })
      ).body.status,
    ).toBe('cancelled');
    const removable = await call(
      PM,
      'POST',
      '/subcontracts/work-orders',
      kit.orderInput(project.id, partyId),
    );
    expect(
      (
        await call(
          PM,
          'DELETE',
          `/subcontracts/work-orders/${removable.body.id}?version=${removable.body.version}`,
        )
      ).status,
    ).toBe(204);
  });

  it('replays an idempotent retry and reports a malformed key', async () => {
    const project = await kit.locatedProject();
    const partyId = await kit.contractor();
    const headers = { 'idempotency-key': 'sub-key-1' };
    const body = kit.orderInput(project.id, partyId);
    const first = await call(PM, 'POST', '/subcontracts/work-orders', body, headers);
    const again = await call(PM, 'POST', '/subcontracts/work-orders', body, headers);
    expect(again).toEqual(first);
    const count = await call(PM, 'GET', `/subcontracts/work-orders?projectId=${project.id}`);
    expect(count.body.total).toBe(1);
    const bad = await call(PM, 'POST', '/subcontracts/work-orders', body, {
      'idempotency-key': '',
    });
    expect(bad.status).toBe(400);
  });

  it('refuses retention in the body with the rule, not a type error (BR-8)', async () => {
    const project = await kit.locatedProject();
    const partyId = await kit.contractor();
    const reply = await call(
      PM,
      'POST',
      '/subcontracts/work-orders',
      kit.orderInput(project.id, partyId, { retentionPercent: '5' }),
    );
    expect(reply).toMatchObject({
      status: 422,
      body: { error: { code: 'retention_not_supported' } },
    });
  });

  it('shows a supervisor the orders of their project without amounts (BR-9, T-6)', async () => {
    const order = await kit.activeOrder();
    await kit.assignSupervisor(order.projectId, SUPERVISOR);
    const seen = await call(SUPERVISOR, 'GET', `/subcontracts/work-orders/${order.id}`);
    expect(seen).toMatchObject({
      status: 200,
      body: { contractAmount: null, committedAmount: null },
    });
    const list = await call(SUPERVISOR, 'GET', '/subcontracts/work-orders');
    expect(
      list.body.items.every((o: { contractAmount: unknown }) => o.contractAmount === null),
    ).toBe(true);
    expect(
      (await call(SUPERVISOR, 'GET', `/subcontracts/work-orders/${order.id}/ledger`)).status,
    ).toBe(403);
    const drafted = await call(
      SUPERVISOR,
      'POST',
      `/subcontracts/work-orders/${order.id}/certificates`,
      certificateBody({ cumulativePercent: '10' }),
    );
    expect(drafted).toMatchObject({ status: 201, body: { cumulativeAmount: null } });
    expect(
      (
        await call(SUPERVISOR, 'POST', `/subcontracts/certificates/${drafted.body.id}/submit`, {
          version: 1,
        })
      ).status,
    ).toBe(403);
    expect((await call(SUPERVISOR, 'POST', '/subcontracts/work-orders', orderBody())).status).toBe(
      403,
    );
  });
});

/** Every endpoint once: its method, a path for a record that does not exist and a valid body. */
const endpoints: [string, 'GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?][] = [
  ['list orders', 'GET', '/subcontracts/work-orders'],
  ['create order', 'POST', '/subcontracts/work-orders', orderBody()],
  ['get order', 'GET', `/subcontracts/work-orders/${MISSING}`],
  ['update order', 'PUT', `/subcontracts/work-orders/${MISSING}`, { ...orderBody(), version: 1 }],
  ['delete order', 'DELETE', `/subcontracts/work-orders/${MISSING}?version=1`],
  ['submit order', 'POST', `/subcontracts/work-orders/${MISSING}/submit`, { version: 1 }],
  ['close order', 'POST', `/subcontracts/work-orders/${MISSING}/close`, { version: 1 }],
  ['cancel order', 'POST', `/subcontracts/work-orders/${MISSING}/cancel`, { version: 1 }],
  ['order ledger', 'GET', `/subcontracts/work-orders/${MISSING}/ledger`],
  [
    'add variation',
    'POST',
    `/subcontracts/work-orders/${MISSING}/variations`,
    { amount: '1', reason: 'r' },
  ],
  [
    'update variation',
    'PUT',
    `/subcontracts/variations/${MISSING}`,
    { amount: '1', reason: 'r', version: 1 },
  ],
  ['approve variation', 'POST', `/subcontracts/variations/${MISSING}/approve`, { version: 1 }],
  ['reject variation', 'POST', `/subcontracts/variations/${MISSING}/reject`, { version: 1 }],
  ['list certificates', 'GET', `/subcontracts/work-orders/${MISSING}/certificates`],
  [
    'create certificate',
    'POST',
    `/subcontracts/work-orders/${MISSING}/certificates`,
    certificateBody(),
  ],
  ['get certificate', 'GET', `/subcontracts/certificates/${MISSING}`],
  [
    'update certificate',
    'PUT',
    `/subcontracts/certificates/${MISSING}`,
    { ...certificateBody(), version: 1 },
  ],
  ['submit certificate', 'POST', `/subcontracts/certificates/${MISSING}/submit`, { version: 1 }],
  ['cancel certificate', 'POST', `/subcontracts/certificates/${MISSING}/cancel`, { version: 1 }],
  [
    'bill certificate',
    'POST',
    `/subcontracts/certificates/${MISSING}/bill`,
    { vendorInvoiceNo: 'X', billDate: TODAY, dueDate: TODAY },
  ],
  ['list back-charges', 'GET', `/subcontracts/work-orders/${MISSING}/back-charges`],
  [
    'add back-charge',
    'POST',
    `/subcontracts/work-orders/${MISSING}/back-charges`,
    { description: 'd', amount: '1' },
  ],
  [
    'update back-charge',
    'PUT',
    `/subcontracts/back-charges/${MISSING}`,
    { description: 'd', amount: '1', version: 1 },
  ],
  ['delete back-charge', 'DELETE', `/subcontracts/back-charges/${MISSING}?version=1`],
];

describe('contract tests for every endpoint (constitution 10.3)', () => {
  it.each(endpoints)(
    '%s: refuses anonymous callers and callers without the permission',
    async (_name, method, url, body) => {
      expect((await call(null, method, url, body)).status).toBe(401);
      expect((await call(NOBODY, method, url, body)).status).toBe(403);
    },
  );

  it.each(endpoints.filter((e) => e[0] !== 'list orders'))(
    '%s: reports a missing record as not found',
    async (_name, method, url, body) => {
      expect((await call(ADMIN, method, url, body)).status).toBe(404);
    },
  );

  it.each(endpoints.filter((e) => e[1] !== 'GET' || e[2].includes('MISSING')))(
    '%s: refuses an id that is not a uuid',
    async (_name, method, url, body) => {
      const bad = url.replace(MISSING, 'not-a-uuid');
      if (bad === url) return;
      expect((await call(ADMIN, method, bad, body)).status).toBe(400);
    },
  );

  const invalid: [string, 'GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?][] = [
    ['list orders', 'GET', '/subcontracts/work-orders?status=nonsense'],
    ['create order', 'POST', '/subcontracts/work-orders', { title: 'only' }],
    ['update order', 'PUT', `/subcontracts/work-orders/${MISSING}`, { ...orderBody(), version: 0 }],
    ['delete order', 'DELETE', `/subcontracts/work-orders/${MISSING}`],
    ['submit order', 'POST', `/subcontracts/work-orders/${MISSING}/submit`, {}],
    ['close order', 'POST', `/subcontracts/work-orders/${MISSING}/close`, { version: 'x' }],
    ['cancel order', 'POST', `/subcontracts/work-orders/${MISSING}/cancel`, {}],
    [
      'add variation',
      'POST',
      `/subcontracts/work-orders/${MISSING}/variations`,
      { amount: 'abc', reason: 'r' },
    ],
    ['update variation', 'PUT', `/subcontracts/variations/${MISSING}`, { amount: '1' }],
    ['approve variation', 'POST', `/subcontracts/variations/${MISSING}/approve`, {}],
    ['reject variation', 'POST', `/subcontracts/variations/${MISSING}/reject`, {}],
    [
      'create certificate',
      'POST',
      `/subcontracts/work-orders/${MISSING}/certificates`,
      certificateBody({ basis: 'lump' }),
    ],
    ['update certificate', 'PUT', `/subcontracts/certificates/${MISSING}`, certificateBody()],
    ['submit certificate', 'POST', `/subcontracts/certificates/${MISSING}/submit`, {}],
    ['cancel certificate', 'POST', `/subcontracts/certificates/${MISSING}/cancel`, {}],
    [
      'bill certificate',
      'POST',
      `/subcontracts/certificates/${MISSING}/bill`,
      { vendorInvoiceNo: 'X' },
    ],
    [
      'add back-charge',
      'POST',
      `/subcontracts/work-orders/${MISSING}/back-charges`,
      { description: '', amount: '1' },
    ],
    ['update back-charge', 'PUT', `/subcontracts/back-charges/${MISSING}`, { description: 'd' }],
    ['delete back-charge', 'DELETE', `/subcontracts/back-charges/${MISSING}`],
  ];
  it.each(invalid)('%s: refuses a malformed request', async (_name, method, url, body) => {
    expect((await call(ADMIN, method, url, body)).status).toBe(400);
  });

  it('reports a version conflict for every command that takes a version', async () => {
    const order = await kit.activeOrder();
    const variation = await call(PM, 'POST', `/subcontracts/work-orders/${order.id}/variations`, {
      amount: '10',
      reason: 'r',
    });
    const stale = 99;
    // Decisions come first: a variation cannot be decided while a certificate is open.
    for (const [user, path] of [
      [ADMIN, 'approve'],
      [MANAGEMENT, 'reject'],
    ] as const) {
      const reply = await call(
        user,
        'POST',
        `/subcontracts/variations/${variation.body.id}/${path}`,
        { version: stale },
      );
      expect(reply.status, path).toBe(409);
    }
    const draft = await kit.draftCertificate(order.id);
    const charge = await kit.backCharge(order.id);
    const checks: [string, 'POST' | 'PUT' | 'DELETE', string, unknown?][] = [
      [
        'PUT',
        'PUT',
        `/subcontracts/work-orders/${order.id}`,
        { ...kit.orderInput(order.projectId, order.partyId), version: stale },
      ],
      ['submit', 'POST', `/subcontracts/work-orders/${order.id}/submit`, { version: stale }],
      [
        'close',
        'POST',
        `/subcontracts/work-orders/${order.id}/close`,
        { version: stale, reason: 'x' },
      ],
      ['cancel', 'POST', `/subcontracts/work-orders/${order.id}/cancel`, { version: stale }],
      [
        'variation',
        'PUT',
        `/subcontracts/variations/${variation.body.id}`,
        { amount: '1', reason: 'r', version: stale },
      ],
      [
        'certificate',
        'PUT',
        `/subcontracts/certificates/${draft.id}`,
        { ...certificateBody(), version: stale },
      ],
      [
        'certificate submit',
        'POST',
        `/subcontracts/certificates/${draft.id}/submit`,
        { version: stale },
      ],
      [
        'certificate cancel',
        'POST',
        `/subcontracts/certificates/${draft.id}/cancel`,
        { version: stale },
      ],
      [
        'back-charge',
        'PUT',
        `/subcontracts/back-charges/${charge.id}`,
        { description: 'd', amount: '1', version: stale },
      ],
      ['back-charge delete', 'DELETE', `/subcontracts/back-charges/${charge.id}?version=${stale}`],
    ];
    for (const [name, method, url, body] of checks) {
      const reply = await call(ADMIN, method, url, body);
      expect(reply.status, name).toBe(409);
    }
  });

  it('replays an idempotent retry of a command', async () => {
    const order = await kit.activeOrder();
    const url = `/subcontracts/work-orders/${order.id}/variations`;
    const headers = { 'idempotency-key': 'variation-retry' };
    const first = await call(PM, 'POST', url, { amount: '10', reason: 'r' }, headers);
    const again = await call(PM, 'POST', url, { amount: '10', reason: 'r' }, headers);
    expect(again).toEqual(first);
    expect(
      (await call(PM, 'GET', `/subcontracts/work-orders/${order.id}`)).body.variations,
    ).toHaveLength(1);
  });
});
