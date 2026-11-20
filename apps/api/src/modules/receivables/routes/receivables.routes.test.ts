/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the tests read parsed JSON answers */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  TODAY,
  createReceivablesKit,
  uid,
  type ReceivablesKit,
} from '../test-support.js';

let kit: ReceivablesKit;
let party: string;
let bank: string;
beforeAll(async () => {
  kit = await createReceivablesKit();
  party = await kit.partyId();
  bank = await kit.bank();
}, 120_000);
afterAll(() => kit.close());

const MISSING = uid(987654);

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
async function call(
  userId: string,
  method: Method,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await kit.rapp.inject({
    method,
    url,
    headers: { ...(await kit.racc(userId)), ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return {
    status: res.statusCode,
    body: res.body === '' ? null : JSON.parse(res.body),
  };
}
const acc = (method: Method, url: string, body?: unknown, headers?: Record<string, string>) =>
  call(ACCOUNTANT, method, url, body, headers);

const newReceipt = async (amount = '10', over: Record<string, unknown> = {}) => {
  const res = await acc('POST', '/receivables/receipts', {
    partyId: party,
    receiptDate: TODAY,
    method: 'bank_transfer',
    amount,
    accountId: bank,
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body;
};
const newCheque = async (over: Record<string, unknown> = {}) =>
  newReceipt('100', {
    method: 'pdc',
    accountId: undefined,
    cheque: { chequeNumber: 'RT-1', bankName: 'Route Bank', chequeDate: TODAY },
    ...over,
  });
const pdcOf = async (receiptId: string) => {
  const res = await acc('GET', '/receivables/pdcs');
  return res.body?.items.find((p: any) => p.receiptId === receiptId);
};

describe('permissions (spec section 6)', () => {
  const requests: [Method, string, unknown?][] = [
    ['GET', '/receivables/receipts'],
    ['GET', `/receivables/receipts/${MISSING}`],
    ['POST', '/receivables/receipts', {}],
    ['POST', `/receivables/receipts/${MISSING}/allocate`, {}],
    ['POST', `/receivables/receipts/${MISSING}/cancel`, {}],
    ['GET', `/receivables/customers/${MISSING}/ledger`],
    ['GET', `/receivables/customers/${MISSING}/statement?from=2026-01-01&to=2026-12-31`],
    ['GET', `/receivables/customers/${MISSING}/open-invoices`],
    ['GET', `/receivables/customers/${MISSING}/suggest-allocation?amount=1`],
    ['GET', '/receivables/aging?asOf=2026-11-18'],
    ['GET', '/receivables/pdcs'],
    ['GET', `/receivables/pdcs/${MISSING}`],
    ['POST', `/receivables/pdcs/${MISSING}/deposit`, {}],
    ['POST', `/receivables/pdcs/${MISSING}/clear`, {}],
    ['POST', `/receivables/pdcs/${MISSING}/bounce`, {}],
    ['POST', `/receivables/pdcs/${MISSING}/return`, {}],
    ['POST', `/receivables/pdcs/${MISSING}/replace`, {}],
    ['GET', '/receivables/followups'],
    ['POST', '/receivables/followups', {}],
    ['PUT', `/receivables/followups/${MISSING}`, {}],
    ['DELETE', `/receivables/followups/${MISSING}?version=1`],
    ['GET', `/receivables/adjustments?partyId=${MISSING}`],
    ['POST', '/receivables/adjustments/approval-requests', {}],
    ['POST', '/receivables/adjustments', {}],
  ];

  it('refuses a user without any permission on every endpoint', async () => {
    for (const [method, url, body] of requests) {
      expect((await call(NOBODY, method, url, body)).status, `${method} ${url}`).toBe(403);
    }
  });

  it('lets management read the ledger but not record or change anything', async () => {
    for (const [method, url, body] of requests) {
      const status = (await call(MANAGEMENT, method, url, body)).status;
      if (method === 'GET' && !url.includes('suggest-allocation')) {
        expect(status, `${method} ${url}`).not.toBe(403);
      } else {
        expect(status, `${method} ${url}`).toBe(403);
      }
    }
  });

  it('needs a login', async () => {
    const res = await kit.rapp.inject({ method: 'GET', url: '/receivables/receipts' });
    expect(res.statusCode).toBe(401);
  });
});

describe('receipts', () => {
  it('records a receipt, replays an idempotent retry and reads it back', async () => {
    const body = {
      partyId: party,
      receiptDate: TODAY,
      method: 'cash',
      amount: '12',
      accountId: bank,
    };
    const headers = { 'idempotency-key': 'rcv-key-1' };
    const first = await acc('POST', '/receivables/receipts', body, headers);
    const second = await acc('POST', '/receivables/receipts', body, headers);
    expect(first.status).toBe(201);
    expect(second.body?.id).toBe(first.body?.id);
    const bad = await acc('POST', '/receivables/receipts', body, { 'idempotency-key': '' });
    expect(bad.status).toBe(400);
    const one = await acc('GET', `/receivables/receipts/${first.body?.id}`);
    expect(one.body).toMatchObject({ amount: '12.00', status: 'cleared', method: 'cash' });
    const list = await acc('GET', `/receivables/receipts?partyId=${party}&limit=5`);
    expect(list.body?.items.length).toBeGreaterThan(0);
    expect((await acc('GET', `/receivables/receipts/${MISSING}`)).status).toBe(404);
  });

  it('validates the body', async () => {
    const base = {
      partyId: party,
      receiptDate: TODAY,
      method: 'cash',
      amount: '1',
      accountId: bank,
    };
    for (const bad of [
      { ...base, amount: '-1' },
      { ...base, amount: '1.234' },
      { ...base, receiptDate: '18/11/2026' },
      { ...base, method: 'barter' },
      { ...base, partyId: 'nope' },
      { ...base, allocations: [{ kind: 'invoice', invoiceId: 'x', amount: '1' }] },
    ]) {
      expect((await acc('POST', '/receivables/receipts', bad)).status).toBe(400);
    }
    // Business rules answer 422.
    const noAccount = await acc('POST', '/receivables/receipts', { ...base, accountId: undefined });
    expect(noAccount.status).toBe(400);
    expect(JSON.stringify(noAccount.body)).toContain('account_required');
  });

  it('allocates once and answers 404 for an unknown receipt', async () => {
    const invoice = await kit.invoice();
    const receipt = await newReceipt('50');
    const body = { allocations: [{ kind: 'invoice', invoiceId: invoice.id, amount: '50' }] };
    const done = await acc('POST', `/receivables/receipts/${receipt.id}/allocate`, body);
    expect(done.status).toBe(200);
    expect(done.body?.unallocated).toBe('0.00');
    expect((await acc('POST', `/receivables/receipts/${receipt.id}/allocate`, body)).status).toBe(
      422,
    );
    expect((await acc('POST', `/receivables/receipts/${MISSING}/allocate`, body)).status).toBe(404);
    expect(
      (await acc('POST', `/receivables/receipts/${receipt.id}/allocate`, { allocations: [] }))
        .status,
    ).toBe(400);
  });

  it('cancels with a reason, a current version and answers 409 on an old one', async () => {
    const receipt = await newReceipt('20');
    const url = `/receivables/receipts/${receipt.id}/cancel`;
    expect((await acc('POST', url, { reason: '', version: 1 })).status).toBe(400);
    expect((await acc('POST', url, { reason: 'Typo', version: 9 })).status).toBe(409);
    expect(
      (await acc('POST', `/receivables/receipts/${MISSING}/cancel`, { reason: 'x', version: 1 }))
        .status,
    ).toBe(404);
    const done = await acc('POST', url, { reason: 'Typo', version: receipt.version });
    expect(done.status).toBe(200);
    expect(done.body?.status).toBe('cancelled');
    expect((await acc('POST', url, { reason: 'Again', version: done.body?.version })).status).toBe(
      422,
    );
  });
});

describe('customers, statement and aging', () => {
  it('answers the ledger, open invoices, suggestion, statement and aging', async () => {
    const invoice = await kit.invoice();
    const ledger = await acc('GET', `/receivables/customers/${party}/ledger`);
    expect(ledger.status).toBe(200);
    expect(ledger.body).toMatchObject({
      balance: { partyId: party },
      receipts: { total: expect.any(Number) },
    });
    expect(ledger.body?.openInvoices.some((row: any) => row.invoiceId === invoice.id)).toBe(true);
    expect(
      (await acc('GET', `/receivables/customers/${party}/ledger?date=2026-11-17`)).body
        ?.openInvoices,
    ).toEqual([]);
    const open = await acc('GET', `/receivables/customers/${party}/open-invoices`);
    expect(open.body.length).toBeGreaterThan(0);
    const suggestion = await acc(
      'GET',
      `/receivables/customers/${party}/suggest-allocation?amount=10`,
    );
    expect(suggestion.body).toEqual([{ invoiceId: expect.any(String), amount: '10.00' }]);
    expect((await acc('GET', `/receivables/customers/${party}/suggest-allocation`)).status).toBe(
      400,
    );
    const statement = await acc(
      'GET',
      `/receivables/customers/${party}/statement?from=2026-01-01&to=2026-12-31`,
    );
    expect(statement.body).toMatchObject({ opening: '0.00', partyId: party });
    expect(
      (await acc('GET', `/receivables/customers/${party}/statement?from=2026-01-01`)).status,
    ).toBe(400);
    const byProject = await acc('GET', '/receivables/aging?asOf=2026-12-31&groupBy=project');
    expect(byProject.body?.labels).toHaveLength(5);
    expect((await acc('GET', '/receivables/aging?asOf=2026-12-31')).body?.groupBy).toBe('customer');
    expect((await acc('GET', '/receivables/aging')).status).toBe(400);
    expect((await call(MANAGEMENT, 'GET', `/receivables/customers/${party}/ledger`)).status).toBe(
      200,
    );
  });
});

describe('cheques', () => {
  it('runs a cheque from receipt to clearing and lists it in the register', async () => {
    const receipt = await newCheque();
    const pdc = await pdcOf(receipt.id);
    expect(pdc).toMatchObject({ status: 'received', chequeNumber: 'RT-1' });
    const deposited = await acc('POST', `/receivables/pdcs/${pdc.id}/deposit`, {
      accountId: bank,
      version: pdc.version,
    });
    expect(deposited.body?.status).toBe('deposited');
    const cleared = await acc(
      'POST',
      `/receivables/pdcs/${pdc.id}/clear`,
      { version: deposited.body?.version },
      { 'idempotency-key': 'clear-1' },
    );
    expect(cleared.body?.status).toBe('cleared');
    const replay = await acc(
      'POST',
      `/receivables/pdcs/${pdc.id}/clear`,
      { version: deposited.body?.version },
      { 'idempotency-key': 'clear-1' },
    );
    expect(replay.body?.version).toBe(cleared.body?.version);
    expect((await acc('GET', `/receivables/pdcs/${pdc.id}`)).body?.status).toBe('cleared');
    const register = await acc('GET', '/receivables/pdcs?status=cleared');
    expect(register.body?.items.every((p: any) => p.status === 'cleared')).toBe(true);
    expect((await acc('GET', '/receivables/pdcs?status=nope')).status).toBe(400);
    expect((await acc('GET', `/receivables/pdcs/${MISSING}`)).status).toBe(404);
  });

  it('bounces, returns and replaces; answers 404, 409 and 422 as the rules require', async () => {
    const first = await pdcOf((await newCheque()).id);
    const bad = `/receivables/pdcs/${first.id}`;
    expect((await acc('POST', `${bad}/deposit`, { version: 1 })).status).toBe(400);
    expect((await acc('POST', `${bad}/deposit`, { accountId: bank, version: 9 })).status).toBe(409);
    expect((await acc('POST', `${bad}/clear`, { version: first.version })).status).toBe(422);
    expect((await acc('POST', `/receivables/pdcs/${MISSING}/clear`, { version: 1 })).status).toBe(
      404,
    );
    const dep = await acc('POST', `${bad}/deposit`, { accountId: bank, version: first.version });
    expect(
      (await acc('POST', `${bad}/bounce`, { reason: '', version: dep.body?.version })).status,
    ).toBe(400);
    const bounced = await acc('POST', `${bad}/bounce`, {
      reason: 'No funds',
      version: dep.body?.version,
    });
    expect(bounced.body).toMatchObject({ status: 'bounced', bounceReason: 'No funds' });
    const replacement = await acc('POST', `${bad}/replace`, {
      cheque: { chequeNumber: 'RT-2', bankName: 'Other', chequeDate: TODAY },
      version: bounced.body?.version,
    });
    expect(replacement.status).toBe(201);
    expect(replacement.body?.chequeNumber).toBe('RT-2');
    expect((await acc('POST', `${bad}/replace`, { cheque: {}, version: 1 })).status).toBe(400);

    const held = await pdcOf((await newCheque()).id);
    const returned = await acc('POST', `/receivables/pdcs/${held.id}/return`, {
      reason: 'Client collected',
      version: held.version,
    });
    expect(returned.body?.status).toBe('returned');
  });
});

describe('follow-ups', () => {
  it('creates, lists, updates and deletes', async () => {
    const created = await acc('POST', '/receivables/followups', {
      partyId: party,
      dueDate: TODAY,
      note: 'Call',
    });
    expect(created.status).toBe(201);
    const id = created.body?.id;
    expect(
      (await acc('GET', `/receivables/followups?partyId=${party}&status=open`)).body.some(
        (f: any) => f.id === id,
      ),
    ).toBe(true);
    expect((await acc('GET', '/receivables/followups?status=nope')).status).toBe(400);
    expect(
      (await acc('POST', '/receivables/followups', { partyId: party, dueDate: TODAY })).status,
    ).toBe(400);
    const updated = await acc('PUT', `/receivables/followups/${id}`, {
      note: 'Visit',
      version: created.body?.version,
    });
    expect(updated.body?.note).toBe('Visit');
    expect(
      (
        await acc('PUT', `/receivables/followups/${id}`, {
          note: 'Old',
          version: created.body?.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (await acc('PUT', `/receivables/followups/${MISSING}`, { note: 'x', version: 1 })).status,
    ).toBe(404);
    expect((await acc('DELETE', `/receivables/followups/${id}?version=1`)).status).toBe(409);
    expect((await acc('DELETE', `/receivables/followups/${id}`)).status).toBe(400);
    expect(
      (await acc('DELETE', `/receivables/followups/${id}?version=${updated.body?.version}`)).status,
    ).toBe(200);
    expect((await acc('DELETE', `/receivables/followups/${MISSING}?version=1`)).status).toBe(404);
  });
});

describe('write-offs', () => {
  it('asks for approval, records the write-off and lists it', async () => {
    await kit.setting('receivables.small_balance_limit', '100');
    const invoice = await kit.invoice();
    const paid = (Number(invoice.gross) - 30).toFixed(2);
    await newReceipt(paid, {
      allocations: [{ kind: 'invoice', invoiceId: invoice.id, amount: paid }],
    });
    const request = await acc('POST', '/receivables/adjustments/approval-requests', {
      invoiceId: invoice.id,
      amount: '30',
    });
    expect(request.status).toBe(201);
    const docId = request.body?.approvalDocId;
    const body = { invoiceId: invoice.id, amount: '30', reason: 'Rounding', approvalDocId: docId };
    expect((await acc('POST', '/receivables/adjustments', body)).status).toBe(422);
    await kit.decide('write_off', docId, 'approve');
    const done = await acc('POST', '/receivables/adjustments', body, {
      'idempotency-key': 'adj-1',
    });
    expect(done.status).toBe(201);
    const replay = await acc('POST', '/receivables/adjustments', body, {
      'idempotency-key': 'adj-1',
    });
    expect(replay.body?.id).toBe(done.body?.id);
    expect(
      (await acc('GET', `/receivables/adjustments?partyId=${party}`)).body.length,
    ).toBeGreaterThan(0);
    expect((await acc('GET', '/receivables/adjustments')).status).toBe(400);
    expect(
      (await acc('POST', '/receivables/adjustments', { ...body, invoiceId: MISSING })).status,
    ).toBe(404);
    expect((await acc('POST', '/receivables/adjustments', { ...body, amount: '-1' })).status).toBe(
      400,
    );
    expect(
      (await acc('POST', '/receivables/adjustments/approval-requests', { invoiceId: invoice.id }))
        .status,
    ).toBe(400);
    await kit.setting('receivables.small_balance_limit', '0');
  });
});
