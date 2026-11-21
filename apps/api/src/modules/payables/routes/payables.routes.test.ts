import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  MANAGEMENT,
  NOBODY,
  PROCUREMENT,
  TODAY,
  createPayablesKit,
  type PayablesKit,
} from '../test-support.js';

let kit: PayablesKit;
let account: string;
beforeAll(async () => {
  kit = await createPayablesKit();
  account = await kit.bank();
  await kit.withholdingRule();
}, 180_000);
afterAll(() => kit.close());

/** The fields of the answers these tests read. */
interface Doc {
  id: string;
  version: number;
  status: string;
  vendorPartyId: string;
  notes: string;
  asOf: string;
  total: string;
  withholdingCertificateNo: string | null;
  balance: { balance: string };
  items: { id: string }[];
  rows: unknown[];
  payments: unknown[];
}

interface Reply {
  status: number;
  body: Doc;
}

async function call(
  user: string | null,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await kit.papp.inject({
    method,
    url,
    headers: { ...(user === null ? {} : await kit.auth(user)), ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.json<Doc>() };
}

/** A received order and the JSON body of its bill. */
async function billBody(over: Record<string, unknown> = {}) {
  const received = await kit.receipt();
  const input = kit.billInput(received);
  return { received, body: { ...input, ...over } };
}

/** The bill moved by routes to `posted`. */
async function postedBillByRoutes(works = false) {
  const { received, body } = await billBody(works ? { nature: 'works' } : {});
  const created = await call(ACCOUNTANT, 'POST', '/payables/bills', body);
  expect(created.status).toBe(201);
  const matched = await call(ACCOUNTANT, 'POST', `/payables/bills/${created.body.id}/match`, {
    version: created.body.version,
  });
  const submitted = await call(ACCOUNTANT, 'POST', `/payables/bills/${created.body.id}/submit`, {
    version: matched.body.version,
  });
  await kit.decide('vendor_bill', created.body.id, 'approve');
  const approved = await call(ACCOUNTANT, 'GET', `/payables/bills/${created.body.id}`);
  const posted = await call(ACCOUNTANT, 'POST', `/payables/bills/${created.body.id}/post`, {
    version: approved.body.version,
  });
  expect(submitted.status).toBe(200);
  expect(posted.status).toBe(200);
  return { received, bill: posted.body };
}

describe('bills over HTTP', () => {
  it('walks a bill from entry to posting (AC-1)', async () => {
    const { bill } = await postedBillByRoutes();
    expect(bill).toMatchObject({ status: 'posted', grossTotal: '5500.00' });
    const list = await call(
      PROCUREMENT,
      'GET',
      `/payables/bills?vendorPartyId=${bill.vendorPartyId}&status=posted`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((b: { id: string }) => b.id)).toEqual([bill.id]);
  });

  it('edits and cancels a draft', async () => {
    const { received, body } = await billBody();
    const created = await call(PROCUREMENT, 'POST', '/payables/bills', body);
    const edited = await call(PROCUREMENT, 'PUT', `/payables/bills/${created.body.id}`, {
      ...body,
      version: created.body.version,
      notes: 'edited',
    });
    expect(edited).toMatchObject({ status: 200, body: { notes: 'edited' } });
    const accountant = await call(ACCOUNTANT, 'POST', `/payables/bills/${created.body.id}/cancel`, {
      reason: 'Mistake',
      version: edited.body.version,
    });
    expect(accountant).toMatchObject({ status: 200, body: { status: 'cancelled' } });
    expect(received.vendorId).toBeTruthy();
  });

  it('refuses bad bodies, other roles and anonymous callers', async () => {
    const { body } = await billBody();
    expect((await call(ACCOUNTANT, 'POST', '/payables/bills', { ...body, lines: [] })).status).toBe(
      400,
    );
    expect((await call(ACCOUNTANT, 'GET', '/payables/bills?status=nonsense')).status).toBe(400);
    expect((await call(ACCOUNTANT, 'GET', '/payables/bills/not-a-uuid')).status).toBe(400);
    expect((await call(NOBODY, 'POST', '/payables/bills', body)).status).toBe(403);
    expect((await call(NOBODY, 'GET', '/payables/bills')).status).toBe(403);
    expect((await call(null, 'GET', '/payables/bills')).status).toBe(401);
    expect(
      (await call(ACCOUNTANT, 'GET', '/payables/bills/018f7c7c-0000-7000-8000-000000000009'))
        .status,
    ).toBe(404);
    // A procurement officer may enter and read bills but not post them.
    const posting = await call(
      PROCUREMENT,
      'POST',
      '/payables/bills/018f7c7c-0000-7000-8000-000000000009/post',
      { version: 1 },
    );
    expect(posting.status).toBe(403);
  });

  it('replays a command with the same Idempotency-Key and refuses a malformed key', async () => {
    const { body } = await billBody();
    const headers = { 'idempotency-key': 'bill-key-1' };
    const first = await call(ACCOUNTANT, 'POST', '/payables/bills', body, headers);
    const second = await call(ACCOUNTANT, 'POST', '/payables/bills', body, headers);
    expect(first.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    const empty = await call(ACCOUNTANT, 'POST', '/payables/bills', body, {
      'idempotency-key': '',
    });
    expect(empty.status).toBe(400);
  });
});

describe('payments over HTTP', () => {
  it('creates, submits, approves, pays, certifies and cancels', async () => {
    await kit.setThreshold('0');
    const { bill } = await postedBillByRoutes(true);
    const created = await call(ACCOUNTANT, 'POST', '/payables/payments', {
      vendorPartyId: bill.vendorPartyId,
      paymentDate: TODAY,
      method: 'bank_transfer',
      accountId: account,
      allocations: [{ billId: bill.id, amount: '5500' }],
    });
    expect(created).toMatchObject({
      status: 201,
      body: { amount: '5400.00', withholdingDeducted: '100.00' },
    });
    const submitted = await call(
      ACCOUNTANT,
      'POST',
      `/payables/payments/${created.body.id}/submit`,
      {
        version: created.body.version,
      },
    );
    expect(submitted.body.status).toBe('pending_approval');
    expect(
      (
        await call(ACCOUNTANT, 'POST', `/payables/payments/${created.body.id}/pay`, {
          version: submitted.body.version,
        })
      ).status,
    ).toBe(422);
    await kit.decide('payment', created.body.id, 'approve');
    const approved = await call(ACCOUNTANT, 'GET', `/payables/payments/${created.body.id}`);
    const certificate = await call(
      ACCOUNTANT,
      'PUT',
      `/payables/payments/${created.body.id}/certificate`,
      {
        certificateNo: 'WHT-1',
        version: approved.body.version,
      },
    );
    expect(certificate.body.withholdingCertificateNo).toBe('WHT-1');
    const paid = await call(ACCOUNTANT, 'POST', `/payables/payments/${created.body.id}/pay`, {
      version: certificate.body.version,
    });
    expect(paid).toMatchObject({ status: 200, body: { status: 'paid' } });
    const cancelled = await call(
      ACCOUNTANT,
      'POST',
      `/payables/payments/${created.body.id}/cancel`,
      {
        reason: 'Bounced',
        version: paid.body.version,
      },
    );
    expect(cancelled.body.status).toBe('cancelled');
    const list = await call(
      MANAGEMENT,
      'GET',
      `/payables/payments?vendorPartyId=${bill.vendorPartyId}&status=cancelled`,
    );
    expect(list.body.items).toHaveLength(1);
    expect((await call(NOBODY, 'GET', '/payables/payments')).status).toBe(403);
    expect((await call(PROCUREMENT, 'POST', '/payables/payments', {})).status).toBe(403);
  });

  it('creates a payment run', async () => {
    const { bill } = await postedBillByRoutes();
    const run = await call(ACCOUNTANT, 'POST', '/payables/payment-runs', {
      billIds: [bill.id],
      paymentDate: TODAY,
      method: 'cash',
      accountId: account,
    });
    expect(run).toMatchObject({ status: 201, body: { total: '5500.00' } });
    expect((await call(ACCOUNTANT, 'POST', '/payables/payment-runs', { billIds: [] })).status).toBe(
      400,
    );
  });
});

describe('ledgers and reports over HTTP', () => {
  it('reads the vendor ledger, open bills, aging and the withholding report', async () => {
    const { bill } = await postedBillByRoutes();
    const ledger = await call(
      MANAGEMENT,
      'GET',
      `/payables/vendors/${bill.vendorPartyId}/ledger?date=${TODAY}`,
    );
    expect(ledger.body.balance.balance).toBe('5500.00');
    expect(
      (await call(MANAGEMENT, 'GET', `/payables/vendors/${bill.vendorPartyId}/ledger`)).status,
    ).toBe(200);
    const open = await call(
      PROCUREMENT,
      'GET',
      `/payables/vendors/${bill.vendorPartyId}/open-bills`,
    );
    expect(open.body).toHaveLength(1);
    expect((await call(MANAGEMENT, 'GET', '/payables/aging?asOf=2026-12-30')).body.asOf).toBe(
      '2026-12-30',
    );
    expect((await call(MANAGEMENT, 'GET', '/payables/aging')).status).toBe(200);
    const report = await call(
      ADMIN,
      'GET',
      '/payables/withholding-report?month=2026-10&authorityCode=FBR',
    );
    expect(report.status).toBe(200);
    expect(Array.isArray(report.body.rows)).toBe(true);
    expect((await call(ADMIN, 'GET', '/payables/withholding-report?month=2026-13')).status).toBe(
      400,
    );
    expect((await call(PROCUREMENT, 'GET', '/payables/aging')).status).toBe(403);
  });
});
