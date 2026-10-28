import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  STOREKEEPER,
  SUPERVISOR,
  createExpensesKit,
  eventCount,
  type ExpensesKit,
} from '../test-support.js';
import type { AdvanceDto, CategoryDto, ClaimDto, CustodianDto, PageResult } from '../types.js';

let kit: ExpensesKit;
beforeAll(async () => {
  kit = await createExpensesKit();
}, 60_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = PM, body, key }: Call) => {
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
const newKey = () => `exp-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';

const claimBody = (over: Record<string, unknown> = {}) => ({ ...kit.input(), ...over });

const makeClaim = async (user = PM, over: Record<string, unknown> = {}) => {
  const response = await call({
    method: 'POST',
    url: '/expenses/claims',
    user,
    body: claimBody(over),
    key: newKey(),
  });
  expect(response.status).toBe(201);
  return response.body as ClaimDto;
};

const post = (id: string, action: string, payload: object, user = PM) =>
  call({
    method: 'POST',
    url: `/expenses/claims/${id}/${action}`,
    user,
    body: payload,
    key: newKey(),
  });

describe('POST /expenses/claims', () => {
  it('creates once for a repeated Idempotency-Key and refuses a changed body', async () => {
    const payload = claimBody();
    const key = newKey();
    const first = await call({ method: 'POST', url: '/expenses/claims', body: payload, key });
    const second = await call({ method: 'POST', url: '/expenses/claims', body: payload, key });
    expect(first.status).toBe(201);
    expect((second.body as ClaimDto).id).toBe((first.body as ClaimDto).id);
    const changed = await call({
      method: 'POST',
      url: '/expenses/claims',
      body: claimBody({ note: 'Other' }),
      key,
    });
    expect(changed.status).toBe(422);
    const empty = await call({ method: 'POST', url: '/expenses/claims', body: payload, key: '' });
    expect(errorCode(empty)).toBe('invalid_idempotency_key');
  });

  it('validates the body, the references and the permission', async () => {
    const line = kit.line();
    const bad = [
      claimBody({ lines: [] }),
      claimBody({ lines: [{ ...line, amount: '1.234' }] }),
      claimBody({ lines: [{ ...line, amount: '-5' }] }),
      claimBody({ lines: [{ ...line, expenseDate: '23/10/2026' }] }),
      claimBody({ lines: [{ ...line, costCodeId: 'x' }] }),
      claimBody({ lines: [{ ...line, costObjectType: 'store' }] }),
      claimBody({ lines: [{ ...line, description: '' }] }),
      claimBody({ note: 'n'.repeat(2001) }),
    ];
    for (const payload of bad) {
      expect((await call({ method: 'POST', url: '/expenses/claims', body: payload })).status).toBe(
        400,
      );
    }
    const unknownCategory = await call({
      method: 'POST',
      url: '/expenses/claims',
      body: claimBody({ lines: [{ ...line, category: 'unknown' }] }),
    });
    expect(unknownCategory.status).toBe(400);
    expect(errorCode(unknownCategory)).toBe('category_unknown');
    const projectLine = await call({
      method: 'POST',
      url: '/expenses/claims',
      body: claimBody({ lines: [{ ...line, costObjectType: 'project', costObjectId: null }] }),
    });
    expect(errorCode(projectLine)).toBe('project_required');
    for (const user of [ACCOUNTANT, MANAGEMENT, NOBODY]) {
      expect(
        (await call({ method: 'POST', url: '/expenses/claims', user, body: claimBody() })).status,
      ).toBe(403);
    }
  });

  it('keeps a supervisor to the projects assigned to them', async () => {
    const project = await kit.project();
    const line = kit.line({ costObjectType: 'project', costObjectId: project.id });
    const refused = await call({
      method: 'POST',
      url: '/expenses/claims',
      user: SUPERVISOR,
      body: claimBody({ lines: [line] }),
    });
    expect(refused.status).toBe(404);
    expect(errorCode(refused)).toBe('project_not_found');
  });
});

describe('GET /expenses/claims', () => {
  it('lists for claimants and finance, filters, pages and rejects bad queries', async () => {
    const mine = await makeClaim(STOREKEEPER);
    const own = await call({ method: 'GET', url: '/expenses/claims?limit=200', user: STOREKEEPER });
    expect(own.status).toBe(200);
    expect(
      (own.body as PageResult<ClaimDto>).items.every((c) => c.claimantId === STOREKEEPER),
    ).toBe(true);
    const all = await call({ method: 'GET', url: '/expenses/claims?limit=200', user: ACCOUNTANT });
    expect((all.body as PageResult<ClaimDto>).items.map((c) => c.id)).toContain(mine.id);
    const onlyMine = await call({
      method: 'GET',
      url: '/expenses/claims?mine=true&status=draft',
      user: ACCOUNTANT,
    });
    expect((onlyMine.body as PageResult<ClaimDto>).total).toBe(0);
    for (const query of ['limit=0', 'status=nope', 'offset=-1', 'mine=maybe']) {
      expect((await call({ method: 'GET', url: `/expenses/claims?${query}` })).status).toBe(400);
    }
    expect((await call({ method: 'GET', url: '/expenses/claims', user: NOBODY })).status).toBe(403);
  });
});

describe('GET, PUT and DELETE /expenses/claims/:id', () => {
  it('reads a claim for its owner and finance, and hides it from others', async () => {
    const claim = await makeClaim();
    for (const user of [PM, ACCOUNTANT, MANAGEMENT]) {
      expect(
        (await call({ method: 'GET', url: `/expenses/claims/${claim.id}`, user })).status,
      ).toBe(200);
    }
    expect(
      (await call({ method: 'GET', url: `/expenses/claims/${claim.id}`, user: STOREKEEPER }))
        .status,
    ).toBe(404);
    expect(
      (await call({ method: 'GET', url: `/expenses/claims/${claim.id}`, user: NOBODY })).status,
    ).toBe(403);
    expect((await call({ method: 'GET', url: `/expenses/claims/${MISSING}` })).status).toBe(404);
    expect((await call({ method: 'GET', url: '/expenses/claims/nope' })).status).toBe(400);
  });

  it('updates with the expected version, replays an idempotent retry and reports conflicts', async () => {
    const claim = await makeClaim();
    const body = { ...claimBody({ note: 'Changed' }), version: claim.version };
    const key = newKey();
    const url = `/expenses/claims/${claim.id}`;
    const first = await call({ method: 'PUT', url, body, key });
    const retry = await call({ method: 'PUT', url, body, key });
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect((first.body as ClaimDto).version).toBe(claim.version + 1);
    const stale = await call({ method: 'PUT', url, body, key: newKey() });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
    expect((await call({ method: 'PUT', url, body: { ...body, version: 0 } })).status).toBe(400);
    expect((await call({ method: 'PUT', url, body, user: STOREKEEPER })).status).toBe(404);
    expect((await call({ method: 'PUT', url, body, user: ACCOUNTANT })).status).toBe(403);
    expect((await call({ method: 'PUT', url: `/expenses/claims/${MISSING}`, body })).status).toBe(
      404,
    );
  });

  it('deletes a draft with the version and refuses a stale one', async () => {
    const claim = await makeClaim();
    const url = `/expenses/claims/${claim.id}`;
    expect((await call({ method: 'DELETE', url: `${url}?version=99` })).status).toBe(409);
    expect((await call({ method: 'DELETE', url })).status).toBe(400);
    expect(
      (await call({ method: 'DELETE', url: `${url}?version=${claim.version}`, key: newKey() }))
        .status,
    ).toBe(204);
    expect((await call({ method: 'GET', url })).status).toBe(404);
    expect((await call({ method: 'DELETE', url: `${url}?version=1` })).status).toBe(404);
  });
});

describe('claim commands', () => {
  it('submits, approves and posts (AC-1) with an idempotent retry', async () => {
    const claim = await makeClaim();
    const key = newKey();
    const url = `/expenses/claims/${claim.id}/submit`;
    const body = { version: claim.version };
    const first = await call({ method: 'POST', url, body, key });
    const retry = await call({ method: 'POST', url, body, key });
    expect(first.status).toBe(200);
    expect((first.body as ClaimDto).status).toBe('submitted');
    expect(retry.body).toEqual(first.body);

    await kit.decide(claim.id, 'approve');
    const approved = (await call({ method: 'GET', url: `/expenses/claims/${claim.id}` }))
      .body as ClaimDto;
    expect(approved.status).toBe('approved');

    const posted = await post(claim.id, 'post', { version: approved.version }, ACCOUNTANT);
    expect(posted.status).toBe(200);
    expect((posted.body as ClaimDto).status).toBe('posted');
    const again = await post(
      claim.id,
      'post',
      { version: (posted.body as ClaimDto).version },
      ACCOUNTANT,
    );
    expect(again.status).toBe(422);
    expect(await eventCount(kit.db, 'expense.posted')).toBeGreaterThan(0);
  });

  it('answers a duplicate with a warning that can be acknowledged', async () => {
    const line = kit.line({ amount: '4242.00' });
    const first = await makeClaim(PM, { lines: [line] });
    await post(first.id, 'submit', { version: first.version });
    const second = await makeClaim(PM, { lines: [{ ...line, expenseDate: '2026-10-22' }] });
    const warned = await post(second.id, 'submit', { version: second.version });
    expect(warned.status).toBe(422);
    expect(errorCode(warned)).toBe('duplicate_expense_warning');
    const accepted = await post(second.id, 'submit', {
      version: second.version,
      acknowledgeDuplicates: true,
    });
    expect(accepted.status).toBe(200);
    expect(
      (await post(second.id, 'submit', { version: 1, acknowledgeDuplicates: 'yes' })).status,
    ).toBe(400);
  });

  it('validates and authorises each command', async () => {
    const claim = await makeClaim();
    expect((await post(claim.id, 'submit', {})).status).toBe(400);
    expect((await post(claim.id, 'submit', { version: claim.version }, ACCOUNTANT)).status).toBe(
      403,
    );
    expect((await post(claim.id, 'submit', { version: claim.version }, STOREKEEPER)).status).toBe(
      404,
    );
    expect((await post(MISSING, 'submit', { version: 1 })).status).toBe(404);
    expect((await post(claim.id, 'post', { version: claim.version }, PM)).status).toBe(403);
    expect((await post(claim.id, 'post', {}, ACCOUNTANT)).status).toBe(400);
    expect((await post(claim.id, 'post', { version: claim.version }, ACCOUNTANT)).status).toBe(422);
    expect(
      (await post(claim.id, 'reverse', { version: claim.version, reason: 'x' }, PM)).status,
    ).toBe(403);
    expect((await post(claim.id, 'reverse', { version: claim.version }, ACCOUNTANT)).status).toBe(
      400,
    );
    expect((await post(claim.id, 'cancel', { version: claim.version }, NOBODY)).status).toBe(403);
    expect((await post(claim.id, 'cancel', { version: claim.version }, STOREKEEPER)).status).toBe(
      404,
    );
    expect((await post(claim.id, 'cancel', { version: 99 })).status).toBe(409);
  });

  it('cancels a claim and reverses a posted one with a reason', async () => {
    const draft = await makeClaim();
    const cancelled = await post(draft.id, 'cancel', {
      version: draft.version,
      reason: 'Not needed',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'Not needed' });

    const id = await kit.posted();
    const view = (await call({ method: 'GET', url: `/expenses/claims/${id}`, user: ACCOUNTANT }))
      .body as ClaimDto;
    const refused = await post(id, 'cancel', { version: view.version }, ACCOUNTANT);
    expect(errorCode(refused)).toBe('claim_posted');
    const reversed = await post(
      id,
      'reverse',
      { version: view.version, reason: 'Wrong month' },
      ACCOUNTANT,
    );
    expect(reversed.status).toBe(200);
    expect(reversed.body).toMatchObject({ status: 'cancelled', cancelReason: 'Wrong month' });
  });
});

describe('advances and custodians', () => {
  it('registers a custodian, issues and settles an advance', async () => {
    const put = (user: string, body: unknown, userId = STOREKEEPER) =>
      call({ method: 'PUT', url: `/expenses/custodians/${userId}`, user, body, key: newKey() });
    expect((await put(PM, { floatLimit: '100', active: true })).status).toBe(403);
    expect((await put(ACCOUNTANT, { floatLimit: 'abc', active: true })).status).toBe(400);
    expect((await put(ACCOUNTANT, { floatLimit: '100', active: true }, MISSING)).status).toBe(400);
    const saved = await put(ACCOUNTANT, { floatLimit: '5000', active: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      userId: STOREKEEPER,
      floatLimit: '5000.00',
      balance: '0.00',
    });

    const issueBody = {
      custodianId: STOREKEEPER,
      amount: '1500',
      issuedOn: '2026-10-24',
      purpose: 'Site petty cash',
    };
    const key = newKey();
    const issued = await call({
      method: 'POST',
      url: '/expenses/advances',
      user: ACCOUNTANT,
      body: issueBody,
      key,
    });
    const retry = await call({
      method: 'POST',
      url: '/expenses/advances',
      user: ACCOUNTANT,
      body: issueBody,
      key,
    });
    expect(issued.status).toBe(201);
    expect((retry.body as AdvanceDto).id).toBe((issued.body as AdvanceDto).id);
    for (const bad of [
      { ...issueBody, amount: '0' },
      { ...issueBody, purpose: '' },
      { ...issueBody, issuedOn: 'x' },
    ]) {
      expect(
        (await call({ method: 'POST', url: '/expenses/advances', user: ACCOUNTANT, body: bad }))
          .status,
      ).toBe(400);
    }
    expect(
      (await call({ method: 'POST', url: '/expenses/advances', user: PM, body: issueBody })).status,
    ).toBe(403);
    const unknown = await call({
      method: 'POST',
      url: '/expenses/advances',
      user: ACCOUNTANT,
      body: { ...issueBody, custodianId: MISSING },
    });
    expect(errorCode(unknown)).toBe('custodian_not_found');
    expect(await eventCount(kit.db, 'advance.issued')).toBeGreaterThan(0);

    const advance = issued.body as AdvanceDto;
    const settleUrl = `/expenses/advances/${advance.id}/settle`;
    expect(
      (
        await call({
          method: 'POST',
          url: settleUrl,
          user: ACCOUNTANT,
          body: { version: advance.version },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call({ method: 'POST', url: settleUrl, user: PM, body: { version: 1, note: 'x' } }))
        .status,
    ).toBe(403);
    expect(
      (await call({ method: 'POST', url: settleUrl, user: ACCOUNTANT, body: { note: 'x' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: settleUrl,
          user: ACCOUNTANT,
          body: { version: 9, note: 'x' },
        })
      ).status,
    ).toBe(409);
    const settled = await call({
      method: 'POST',
      url: settleUrl,
      user: ACCOUNTANT,
      body: { version: advance.version, note: 'Cash returned' },
      key: newKey(),
    });
    expect(settled.body).toMatchObject({ status: 'settled', settlementNote: 'Cash returned' });
  });

  it('lists advances, custodians and balances with the right visibility', async () => {
    const advances = await call({
      method: 'GET',
      url: '/expenses/advances?limit=100',
      user: ACCOUNTANT,
    });
    expect(advances.status).toBe(200);
    expect((advances.body as PageResult<AdvanceDto>).total).toBeGreaterThan(0);
    const own = await call({ method: 'GET', url: '/expenses/advances', user: PM });
    expect((own.body as PageResult<AdvanceDto>).items).toEqual([]);
    const filtered = await call({
      method: 'GET',
      url: `/expenses/advances?custodianId=${STOREKEEPER}&status=settled`,
      user: ACCOUNTANT,
    });
    expect((filtered.body as PageResult<AdvanceDto>).items.length).toBeGreaterThan(0);
    for (const query of ['status=nope', 'custodianId=x', 'limit=0']) {
      expect(
        (await call({ method: 'GET', url: `/expenses/advances?${query}`, user: ACCOUNTANT }))
          .status,
      ).toBe(400);
    }
    expect((await call({ method: 'GET', url: '/expenses/advances', user: NOBODY })).status).toBe(
      403,
    );

    const custodians = await call({ method: 'GET', url: '/expenses/custodians', user: MANAGEMENT });
    expect((custodians.body as CustodianDto[]).map((c) => c.userId)).toContain(STOREKEEPER);
    expect((await call({ method: 'GET', url: '/expenses/custodians', user: PM })).status).toBe(403);

    const balance = (user: string, id: string) =>
      call({ method: 'GET', url: `/expenses/custodians/${id}/balance`, user });
    expect((await balance(STOREKEEPER, STOREKEEPER)).body).toMatchObject({ balance: '1500.00' });
    expect((await balance(ACCOUNTANT, STOREKEEPER)).status).toBe(200);
    expect((await balance(PM, STOREKEEPER)).status).toBe(404);
    expect((await balance(ACCOUNTANT, MISSING)).status).toBe(404);
    expect((await balance(NOBODY, STOREKEEPER)).status).toBe(403);
  });
});

describe('GET /expenses/custodian-candidates', () => {
  it('lists the active users for the accountant only', async () => {
    const people = await call({
      method: 'GET',
      url: '/expenses/custodian-candidates',
      user: ACCOUNTANT,
    });
    expect(people.status).toBe(200);
    expect((people.body as { id: string }[]).map((p) => p.id)).toContain(PM);
    for (const user of [PM, MANAGEMENT, NOBODY]) {
      expect(
        (await call({ method: 'GET', url: '/expenses/custodian-candidates', user })).status,
      ).toBe(403);
    }
  });
});

describe('categories', () => {
  it('lists for claimants and changes only for the accountant', async () => {
    const list = await call({ method: 'GET', url: '/expenses/categories', user: STOREKEEPER });
    expect((list.body as CategoryDto[]).map((c) => c.code)).toContain('transport');
    expect((await call({ method: 'GET', url: '/expenses/categories', user: NOBODY })).status).toBe(
      403,
    );

    const body = {
      categories: [{ code: 'fuel', name: 'Fuel', receiptRequired: true, maxWithoutReceipt: '500' }],
    };
    const saved = await call({
      method: 'PUT',
      url: '/expenses/categories',
      user: ACCOUNTANT,
      body,
      key: newKey(),
    });
    expect(saved.status).toBe(200);
    expect((saved.body as CategoryDto[]).find((c) => c.code === 'fuel')).toMatchObject({
      receiptRequired: true,
      maxWithoutReceipt: '500.00',
    });
    expect(
      (await call({ method: 'PUT', url: '/expenses/categories', user: PM, body })).status,
    ).toBe(403);
    const bad = [
      { categories: [] },
      { categories: [{ ...body.categories[0], code: 'Bad Code' }] },
      { categories: [{ ...body.categories[0], maxWithoutReceipt: '-1' }] },
      { categories: [{ ...body.categories[0], receiptRequired: 'yes' }] },
    ];
    for (const payload of bad) {
      expect(
        (
          await call({
            method: 'PUT',
            url: '/expenses/categories',
            user: ACCOUNTANT,
            body: payload,
          })
        ).status,
      ).toBe(400);
    }
  });
});
