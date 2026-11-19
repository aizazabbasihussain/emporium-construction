/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- the tests read parsed JSON answers */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  TODAY,
  createCashbookKit,
  uid,
  type CashbookKit,
} from '../test-support.js';

let kit: CashbookKit;
beforeAll(async () => {
  kit = await createCashbookKit();
  await kit.setting('cashbook.payment_approval_threshold', '999999999');
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
  const res = await kit.app.inject({
    method,
    url,
    headers: { ...(await kit.auth(userId)), ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return {
    status: res.statusCode,
    body: res.body === '' ? null : (JSON.parse(res.body) as Record<string, any>),
  };
}
const acc = (method: Method, url: string, body?: unknown, headers?: Record<string, string>) =>
  call(ACCOUNTANT, method, url, body, headers);

const newAccount = async (over: Record<string, unknown> = {}) => {
  const res = await acc('POST', '/cashbook/accounts', {
    code: `R-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Route account',
    kind: 'bank',
    openingBalance: '1000',
    openingDate: '2026-01-01',
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number };
};

describe('permissions (spec section 6)', () => {
  const requests: [Method, string, unknown?][] = [
    ['GET', '/cashbook/accounts'],
    [
      'POST',
      '/cashbook/accounts',
      { code: 'X', name: 'X', kind: 'bank', openingBalance: '0', openingDate: '2026-01-01' },
    ],
    ['GET', `/cashbook/accounts/${MISSING}`],
    ['PUT', `/cashbook/accounts/${MISSING}`, { name: 'X', version: 1 }],
    ['DELETE', `/cashbook/accounts/${MISSING}?version=1`],
    ['GET', `/cashbook/accounts/${MISSING}/balance?date=${TODAY}`],
    [
      'POST',
      '/cashbook/receipts',
      { accountId: MISSING, txnDate: TODAY, amount: '1', method: 'cash' },
    ],
    [
      'POST',
      '/cashbook/payments',
      { accountId: MISSING, txnDate: TODAY, amount: '1', method: 'cash' },
    ],
    [
      'POST',
      '/cashbook/transfers',
      { fromAccountId: MISSING, toAccountId: uid(2), txnDate: TODAY, amount: '1' },
    ],
    [
      'POST',
      '/cashbook/adjustments',
      { accountId: MISSING, txnDate: TODAY, direction: 'in', amount: '1', reason: 'x' },
    ],
    ['POST', '/cashbook/approval-requests', { docType: 'payment', amount: '1' }],
    ['GET', '/cashbook/transactions'],
    ['GET', `/cashbook/transactions/${MISSING}`],
    ['POST', `/cashbook/transactions/${MISSING}/reverse`, { reason: 'x' }],
    ['PUT', `/cashbook/transactions/${MISSING}/tag`, { accountTag: '1' }],
    ['GET', `/cashbook/position?date=${TODAY}`],
    ['GET', '/cashbook/pending'],
    ['POST', `/cashbook/pending/${MISSING}/record`, { accountId: MISSING }],
    ['GET', '/cashbook/reconciliations'],
    [
      'POST',
      '/cashbook/reconciliations',
      {
        accountId: MISSING,
        statementFrom: TODAY,
        statementTo: TODAY,
        statementClosingBalance: '0',
      },
    ],
    ['GET', `/cashbook/reconciliations/${MISSING}`],
    ['POST', `/cashbook/reconciliations/${MISSING}/import`, { csv: 'x' }],
    [
      'POST',
      `/cashbook/reconciliations/${MISSING}/match`,
      { matches: [{ lineId: MISSING, transactionId: null }] },
    ],
    ['POST', `/cashbook/reconciliations/${MISSING}/complete`, { version: 1 }],
    ['POST', `/cashbook/reconciliations/${MISSING}/reopen`],
  ];

  it('refuses a user with no role on every endpoint', async () => {
    for (const [method, url, body] of requests) {
      expect((await call(NOBODY, method, url, body)).status, `${method} ${url}`).toBe(403);
    }
  });

  it('management reads and manages accounts but does not post, reverse or reconcile', async () => {
    const readable = requests.filter(([m, u]) => m === 'GET' && !u.includes(MISSING));
    for (const [method, url] of readable) {
      expect((await call(MANAGEMENT, method, url)).status, `${method} ${url}`).toBe(200);
    }
    const account = await call(MANAGEMENT, 'POST', '/cashbook/accounts', {
      code: 'MGMT-1',
      name: 'Owner view',
      kind: 'bank',
      openingBalance: '0',
      openingDate: '2026-01-01',
    });
    expect(account.status).toBe(201);
    const forbidden = requests.filter(
      ([m, u]) =>
        (m === 'POST' && !u.startsWith('/cashbook/accounts')) ||
        (m === 'PUT' && u.includes('/transactions/')),
    );
    for (const [method, url, body] of forbidden) {
      expect((await call(MANAGEMENT, method, url, body)).status, `${method} ${url}`).toBe(403);
    }
  });
});

describe('accounts', () => {
  it('creates, reads, updates and deletes an account, and rejects bad input', async () => {
    const created = await newAccount({ code: 'ROUTE-1', openingBalance: '250.5' });
    const read = await acc('GET', `/cashbook/accounts/${created.id}`);
    expect(read.body).toMatchObject({
      code: 'ROUTE-1',
      openingBalance: '250.50',
      balance: '250.50',
    });
    const updated = await acc('PUT', `/cashbook/accounts/${created.id}`, {
      name: 'Renamed',
      active: true,
      version: created.version,
    });
    expect(updated.body).toMatchObject({ name: 'Renamed', version: created.version + 1 });
    expect((await acc('GET', '/cashbook/accounts?includeInactive=true')).body).toHaveProperty(
      'length',
    );
    expect((await acc('GET', '/cashbook/accounts')).status).toBe(200);
    expect(
      (await acc('DELETE', `/cashbook/accounts/${created.id}?version=${created.version + 1}`))
        .status,
    ).toBe(200);
    expect((await acc('GET', `/cashbook/accounts/${created.id}`)).status).toBe(404);
    expect(
      (
        await acc('POST', '/cashbook/accounts', {
          code: 'X',
          name: 'X',
          kind: 'vault',
          openingBalance: '0',
          openingDate: '2026-01-01',
        })
      ).status,
    ).toBe(400);
    expect((await acc('POST', '/cashbook/accounts', { code: 'ROUTE-2' })).status).toBe(400);
  });

  it('reports the balance on a date', async () => {
    const account = await newAccount({ openingBalance: '40' });
    const res = await acc('GET', `/cashbook/accounts/${account.id}/balance?date=${TODAY}`);
    expect(res.body).toEqual({ accountId: account.id, date: TODAY, balance: '40.00' });
    expect((await acc('GET', `/cashbook/accounts/${account.id}/balance`)).status).toBe(400);
  });
});

describe('receipts, payments, transfers and reversals (AC-1)', () => {
  it('posts, lists with a running balance and reverses with a visible trail', async () => {
    const till = await newAccount({ kind: 'cash', openingBalance: '500' });
    const bank = await newAccount();
    const receipt = await acc('POST', '/cashbook/receipts', {
      accountId: till.id,
      txnDate: TODAY,
      amount: '100',
      method: 'cash',
      reference: 'R-1',
    });
    expect(receipt.status).toBe(201);
    const payment = await acc('POST', '/cashbook/payments', {
      accountId: till.id,
      txnDate: TODAY,
      amount: '30',
      method: 'cash',
    });
    expect(payment.status).toBe(201);
    const transfer = await acc('POST', '/cashbook/transfers', {
      fromAccountId: till.id,
      toAccountId: bank.id,
      txnDate: TODAY,
      amount: '70',
    });
    expect(transfer.body).toMatchObject({ out: { amount: '70.00' }, in: { amount: '70.00' } });

    const book = await acc('GET', `/cashbook/transactions?accountId=${till.id}&limit=10`);
    expect(book.body?.total).toBe(3);
    expect(book.body?.items[0].runningBalance).toBe('500.00');
    expect((await acc('GET', `/cashbook/transactions/${receipt.body?.id}`)).status).toBe(200);

    const reversed = await acc('POST', `/cashbook/transactions/${receipt.body?.id}/reverse`, {
      reason: 'Wrong account',
    });
    expect(reversed.status).toBe(201);
    expect(reversed.body).toHaveLength(1);
    expect((await acc('GET', `/cashbook/transactions/${receipt.body?.id}`)).body?.reversed).toBe(
      true,
    );
    const again = await acc('POST', `/cashbook/transactions/${receipt.body?.id}/reverse`, {
      reason: 'Again',
    });
    expect(again.status).toBe(422);
    expect(again.body?.code ?? again.body?.error?.code).toBe('already_reversed');
  });

  it('refuses cash below zero with the shortfall (AC-3)', async () => {
    const till = await newAccount({ kind: 'cash', openingBalance: '10' });
    const res = await acc('POST', '/cashbook/payments', {
      accountId: till.id,
      txnDate: TODAY,
      amount: '15',
      method: 'cash',
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('insufficient_funds');
  });

  it('replays the first response for a repeated Idempotency-Key', async () => {
    const account = await newAccount();
    const body = { accountId: account.id, txnDate: TODAY, amount: '12', method: 'cash' };
    const headers = { 'idempotency-key': 'route-key-1' };
    const first = await acc('POST', '/cashbook/receipts', body, headers);
    const second = await acc('POST', '/cashbook/receipts', body, headers);
    expect(second.body?.id).toBe(first.body?.id);
    expect(await kit.balance(account.id)).toBe('1012.00');
    const bad = await call(ACCOUNTANT, 'POST', '/cashbook/receipts', body, {
      'idempotency-key': '',
    });
    expect(bad.status).toBe(400);
  });

  it('validates amounts, dates and ids', async () => {
    const account = await newAccount();
    const base = { accountId: account.id, txnDate: TODAY, amount: '1', method: 'cash' };
    for (const bad of [
      { ...base, amount: '-1' },
      { ...base, amount: '1.234' },
      { ...base, txnDate: '18/11/2026' },
      { ...base, method: 'barter' },
      { ...base, accountId: 'nope' },
    ]) {
      expect((await acc('POST', '/cashbook/receipts', bad)).status).toBe(400);
    }
    expect((await acc('GET', '/cashbook/transactions/not-an-id')).status).toBe(400);
    expect((await acc('GET', `/cashbook/transactions/${MISSING}`)).status).toBe(404);
  });
});

describe('approvals, adjustments and tags (BR-1, BR-5, BR-7)', () => {
  it('asks for approval, then records the payment and an adjustment against it', async () => {
    await kit.setting('cashbook.payment_approval_threshold', '0');
    try {
      const account = await newAccount();
      const refused = await acc('POST', '/cashbook/payments', {
        accountId: account.id,
        txnDate: TODAY,
        amount: '5',
        method: 'cash',
      });
      expect(JSON.stringify(refused.body)).toContain('approval_required');

      const request = await acc('POST', '/cashbook/approval-requests', {
        docType: 'payment',
        amount: '5',
        accountId: account.id,
        note: 'Cement',
      });
      expect(request.status).toBe(201);
      await kit.decide('payment', request.body?.approvalDocId, 'approve');
      const paid = await acc('POST', '/cashbook/payments', {
        accountId: account.id,
        txnDate: TODAY,
        amount: '5',
        method: 'cash',
        approvalDocId: request.body?.approvalDocId,
      });
      expect(paid.status).toBe(201);

      const adjustmentRequest = await acc('POST', '/cashbook/approval-requests', {
        docType: 'cash_adjustment',
        amount: '20',
      });
      await kit.decide('cash_adjustment', adjustmentRequest.body?.approvalDocId, 'approve');
      const adjustment = await acc('POST', '/cashbook/adjustments', {
        accountId: account.id,
        txnDate: TODAY,
        direction: 'in',
        amount: '20',
        reason: 'Cash count',
        approvalDocId: adjustmentRequest.body?.approvalDocId,
      });
      expect(adjustment.status).toBe(201);
      expect(adjustment.body?.txnType).toBe('other');
    } finally {
      await kit.setting('cashbook.payment_approval_threshold', '999999999');
    }
  });

  it('tags a transaction, clears the tag and lists the untagged ones', async () => {
    const account = await newAccount();
    const receipt = await acc('POST', '/cashbook/receipts', {
      accountId: account.id,
      txnDate: TODAY,
      amount: '9',
      method: 'cash',
    });
    const needs = await acc('GET', `/cashbook/transactions?accountId=${account.id}&needsTag=true`);
    expect(needs.body?.total).toBe(1);
    const tagged = await acc('PUT', `/cashbook/transactions/${receipt.body?.id}/tag`, {
      accountTag: '4010',
    });
    expect(tagged.body?.accountTag).toBe('4010');
    expect(
      (await acc('GET', `/cashbook/transactions?accountId=${account.id}&needsTag=true`)).body
        ?.total,
    ).toBe(0);
    const cleared = await acc('PUT', `/cashbook/transactions/${receipt.body?.id}/tag`, {
      accountTag: null,
    });
    expect(cleared.body?.accountTag).toBeNull();
  });
});

describe('position, pending sources and reconciliation (AC-2)', () => {
  it('reports the daily cash position', async () => {
    const res = await acc('GET', `/cashbook/position?date=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalCash');
    expect(res.body?.accounts.length).toBeGreaterThan(0);
    expect((await acc('GET', '/cashbook/position')).status).toBe(400);
  });

  it('lists a pending advance and records it from an account', async () => {
    const till = await newAccount({ kind: 'cash', openingBalance: '900' });
    await kit.tx((tx) =>
      kit.platform.events.publish(
        {
          type: 'advance.issued',
          payload: {
            advanceId: uid(4001),
            number: 'ADV-1',
            custodianId: uid(60),
            amount: '400',
            issuedOn: TODAY,
          },
        },
        tx,
      ),
    );
    await kit.platform.events.dispatchDue(kit.db);
    const pending = await acc('GET', '/cashbook/pending?status=pending');
    const item = pending.body?.find((p: { sourceDocId: string }) => p.sourceDocId === uid(4001));
    expect(item).toBeDefined();
    const recorded = await acc('POST', `/cashbook/pending/${item.id}/record`, {
      accountId: till.id,
    });
    expect(recorded.body).toMatchObject({ status: 'recorded' });
    expect(await kit.balance(till.id)).toBe('500.00');
  });

  it('imports a statement, matches it and completes only at a zero difference', async () => {
    const bank = await newAccount({ openingBalance: '100' });
    await acc('POST', '/cashbook/receipts', {
      accountId: bank.id,
      txnDate: TODAY,
      amount: '50',
      method: 'bank_transfer',
    });
    const draft = await acc('POST', '/cashbook/reconciliations', {
      accountId: bank.id,
      statementFrom: '2026-11-01',
      statementTo: TODAY,
      statementClosingBalance: '155',
    });
    expect(draft.status).toBe(201);
    const url = `/cashbook/reconciliations/${draft.body?.id}`;
    const imported = await acc('POST', `${url}/import`, {
      csv: `date,description,debit,credit\n${TODAY},Deposit,,50`,
    });
    expect(imported.body?.suggestions).toHaveLength(1);
    const suggestion = imported.body?.suggestions[0];
    const matched = await acc('POST', `${url}/match`, {
      matches: [{ lineId: suggestion.lineId, transactionId: suggestion.transactionId }],
    });
    expect(matched.body?.lines[0].matchedTransactionId).toBe(suggestion.transactionId);

    const short = await acc('POST', `${url}/complete`, { version: draft.body?.version });
    expect(short.status).toBe(422);
    expect(JSON.stringify(short.body)).toContain('reconciliation_difference');
    expect((await acc('GET', url)).body).toMatchObject({ status: 'draft' });
    expect((await acc('GET', `/cashbook/reconciliations?accountId=${bank.id}`)).body).toHaveLength(
      1,
    );

    const fixed = await acc('POST', '/cashbook/reconciliations', {
      accountId: bank.id,
      statementFrom: '2026-11-01',
      statementTo: TODAY,
      statementClosingBalance: '150',
    });
    const fixedUrl = `/cashbook/reconciliations/${fixed.body?.id}`;
    await acc('POST', `${fixedUrl}/import`, {
      csv: `date,description,debit,credit\n${TODAY},Deposit,,50`,
    });
    const done = await acc('POST', `${fixedUrl}/complete`, { version: fixed.body?.version });
    expect(done.body).toMatchObject({ status: 'completed', difference: '0.00' });
    const reopened = await acc('POST', `${fixedUrl}/reopen`);
    expect(reopened.body?.status).toBe('draft');
  });
});
