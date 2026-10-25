import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  SUPERVISOR,
  createQuotationsKit,
  eventCount,
  type QuotationsKit,
} from '../test-support.js';
import type { PageResult, QuotationDto, QuotationHeaderDto } from '../types.js';

let kit: QuotationsKit;
beforeAll(async () => {
  kit = await createQuotationsKit();
}, 60_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const raw = async ({ method, url, user = PM, body, key }: Call) =>
  kit.app.inject({
    method,
    url,
    headers: {
      ...(await kit.auth(user)),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });

const call = async (c: Call) => {
  const response = await raw(c);
  return {
    status: response.statusCode,
    body: response.body === '' ? null : response.json<unknown>(),
  };
};
const errorCode = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

let keyCounter = 0;
const newKey = () => `qte-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';

const stages = [
  { name: 'Advance', basis: 'percent', percent: '30', conditionText: 'On signing' },
  { name: 'Completion', basis: 'percent', percent: '70' },
];

const createBody = async (over: Record<string, unknown> = {}) => ({
  estimateId: (await kit.lockedEstimate()).id,
  scopeText: 'Build a wall',
  stages,
  ...over,
});

const makeDraft = async (user = PM) => {
  const response = await call({
    method: 'POST',
    url: '/quotations',
    user,
    body: await createBody(),
    key: newKey(),
  });
  expect(response.status).toBe(201);
  return response.body as QuotationDto;
};

describe('GET /quotations', () => {
  it('lists for readers and refuses others', async () => {
    await makeDraft();
    for (const user of [PM, MANAGEMENT, ACCOUNTANT]) {
      const response = await call({ method: 'GET', url: '/quotations', user });
      expect(response.status).toBe(200);
      expect((response.body as PageResult<QuotationHeaderDto>).total).toBeGreaterThan(0);
    }
    for (const user of [SUPERVISOR, NOBODY]) {
      const response = await call({ method: 'GET', url: '/quotations', user });
      expect(response.status).toBe(403);
    }
  });

  it('filters and rejects bad queries', async () => {
    const draft = await makeDraft();
    const found = await call({ method: 'GET', url: `/quotations?q=${draft.number}&status=draft` });
    expect((found.body as PageResult<QuotationHeaderDto>).items.map((q) => q.id)).toEqual([
      draft.id,
    ]);
    for (const url of ['/quotations?limit=0', '/quotations?status=nope', '/quotations?partyId=x']) {
      const response = await call({ method: 'GET', url });
      expect(response.status).toBe(400);
    }
  });
});

describe('GET /quotations/:id and the margin panel (spec section 5)', () => {
  it('shows the margin only to holders of quotations.margin.read', async () => {
    const draft = await makeDraft();
    const asPm = await call({ method: 'GET', url: `/quotations/${draft.id}` });
    expect(asPm.status).toBe(200);
    expect((asPm.body as QuotationDto).margin).toBeNull();
    for (const user of [MANAGEMENT, ACCOUNTANT]) {
      const shown = await call({ method: 'GET', url: `/quotations/${draft.id}`, user });
      expect((shown.body as QuotationDto).margin).toMatchObject({
        totalCost: '1000.00',
        marginPercent: '16.6667',
      });
    }
  });

  it('answers 404 for an unknown id, 400 for a malformed one and 403 without permission', async () => {
    expect((await call({ method: 'GET', url: `/quotations/${MISSING}` })).status).toBe(404);
    expect((await call({ method: 'GET', url: '/quotations/nope' })).status).toBe(400);
    const draft = await makeDraft();
    expect(
      (await call({ method: 'GET', url: `/quotations/${draft.id}`, user: NOBODY })).status,
    ).toBe(403);
  });
});

describe('POST /quotations', () => {
  it('creates once for a repeated Idempotency-Key and refuses a changed body', async () => {
    const body = await createBody();
    const key = newKey();
    const first = await call({ method: 'POST', url: '/quotations', body, key });
    const second = await call({ method: 'POST', url: '/quotations', body, key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.body as QuotationDto).id).toBe((first.body as QuotationDto).id);
    const changed = await call({
      method: 'POST',
      url: '/quotations',
      body: { ...body, title: 'Other' },
      key,
    });
    expect(changed.status).toBe(422);
    const empty = await call({ method: 'POST', url: '/quotations', body, key: '' });
    expect(empty.status).toBe(400);
    expect(errorCode(empty)).toBe('invalid_idempotency_key');
  });

  it('validates the body, the references and the permission', async () => {
    const body = await createBody();
    const badBodies = [
      { ...body, estimateId: 'nope' },
      { ...body, stages: 'x' },
      { ...body, price: '12.345' },
      { ...body, stages: [{ name: '', basis: 'percent', percent: '100' }] },
      { ...body, stages: [{ name: 'A', basis: 'weird', percent: '100' }] },
    ];
    for (const bad of badBodies) {
      expect((await call({ method: 'POST', url: '/quotations', body: bad })).status).toBe(400);
    }
    const sums = await call({
      method: 'POST',
      url: '/quotations',
      body: { ...body, stages: [{ name: 'A', basis: 'percent', percent: '60' }] },
    });
    expect(sums.status).toBe(400);
    expect(errorCode(sums)).toBe('stage_percent_sum');
    const unknown = await call({
      method: 'POST',
      url: '/quotations',
      body: { ...body, estimateId: MISSING },
    });
    expect(unknown.status).toBe(404);
    for (const user of [ACCOUNTANT, SUPERVISOR, NOBODY]) {
      expect((await call({ method: 'POST', url: '/quotations', user, body })).status).toBe(403);
    }
  });
});

describe('PUT and DELETE /quotations/:id', () => {
  it('updates with the expected version and answers a stale one with 409', async () => {
    const draft = await makeDraft();
    const ok = await call({
      method: 'PUT',
      url: `/quotations/${draft.id}`,
      body: { stages, price: '1500', version: draft.version },
      key: newKey(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ price: '1500.00', version: draft.version + 1 });
    const stale = await call({
      method: 'PUT',
      url: `/quotations/${draft.id}`,
      body: { stages, version: draft.version },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
  });

  it('refuses invalid input, unknown ids and missing permission', async () => {
    const draft = await makeDraft();
    const url = `/quotations/${draft.id}`;
    expect((await call({ method: 'PUT', url, body: { stages } })).status).toBe(400);
    expect(
      (await call({ method: 'PUT', url: `/quotations/${MISSING}`, body: { stages, version: 1 } }))
        .status,
    ).toBe(404);
    expect(
      (
        await call({
          method: 'PUT',
          url,
          user: ACCOUNTANT,
          body: { stages, version: draft.version },
        })
      ).status,
    ).toBe(403);
  });

  it('deletes a draft, answers 409 for a stale version, 404 and 403 otherwise', async () => {
    const draft = await makeDraft();
    const url = `/quotations/${draft.id}`;
    expect(
      (await call({ method: 'DELETE', url: `${url}?version=${draft.version + 4}` })).status,
    ).toBe(409);
    expect((await call({ method: 'DELETE', url })).status).toBe(400);
    expect(
      (await call({ method: 'DELETE', url: `${url}?version=${draft.version}`, user: ACCOUNTANT }))
        .status,
    ).toBe(403);
    expect(
      (await call({ method: 'DELETE', url: `${url}?version=${draft.version}`, key: newKey() }))
        .status,
    ).toBe(204);
    expect((await call({ method: 'DELETE', url: `${url}?version=${draft.version}` })).status).toBe(
      404,
    );
  });
});

describe('workflow endpoints (AC-1)', () => {
  it('takes a quotation from draft to accepted and emits quotation.accepted once', async () => {
    const draft = await makeDraft();
    const id = draft.id;
    const accepted0 = await eventCount(kit.db, 'quotation.accepted');

    const submit = await call({
      method: 'POST',
      url: `/quotations/${id}/submit`,
      body: { version: draft.version },
      key: newKey(),
    });
    expect(submit.status).toBe(200);
    expect((submit.body as QuotationDto).status).toBe('pending_approval');
    await kit.decide(id, 'approve');

    const approved = (await call({ method: 'GET', url: `/quotations/${id}` })).body as QuotationDto;
    expect(approved.status).toBe('approved');
    const issueKey = newKey();
    const issue = await call({
      method: 'POST',
      url: `/quotations/${id}/issue`,
      body: { version: approved.version },
      key: issueKey,
    });
    expect(issue.status).toBe(200);
    expect((issue.body as QuotationDto).status).toBe('issued');
    const replay = await call({
      method: 'POST',
      url: `/quotations/${id}/issue`,
      body: { version: approved.version },
      key: issueKey,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(issue.body);

    const issued = issue.body as QuotationDto;
    const acceptBody = { version: issued.version, acceptedByName: 'Client Rep' };
    const acceptKey = newKey();
    const accept = await call({
      method: 'POST',
      url: `/quotations/${id}/accept`,
      body: acceptBody,
      key: acceptKey,
    });
    expect(accept.status).toBe(200);
    expect(accept.body).toMatchObject({ status: 'accepted', acceptedByName: 'Client Rep' });
    const again = await call({
      method: 'POST',
      url: `/quotations/${id}/accept`,
      body: acceptBody,
      key: acceptKey,
    });
    expect(again.body).toEqual(accept.body);
    expect(await eventCount(kit.db, 'quotation.accepted')).toBe(accepted0 + 1);
  });

  it('rejects with a reason and revises', async () => {
    const draft = await makeDraft();
    await kit.issued(draft.id);
    const issued = (await call({ method: 'GET', url: `/quotations/${draft.id}` }))
      .body as QuotationDto;
    const noReason = await call({
      method: 'POST',
      url: `/quotations/${draft.id}/reject`,
      body: { version: issued.version },
    });
    expect(noReason.status).toBe(400);
    const rejected = await call({
      method: 'POST',
      url: `/quotations/${draft.id}/reject`,
      body: { version: issued.version, reason: 'Too expensive' },
      key: newKey(),
    });
    expect(rejected.status).toBe(200);
    expect((rejected.body as QuotationDto).status).toBe('rejected');
    const revision = await call({
      method: 'POST',
      url: `/quotations/${draft.id}/revise`,
      key: newKey(),
    });
    expect(revision.status).toBe(201);
    expect(revision.body).toMatchObject({ revision: 2, status: 'draft' });
    expect((await call({ method: 'POST', url: `/quotations/${draft.id}/revise` })).status).toBe(
      409,
    );
  });

  it('answers 400 for a missing version or name, 404, 409 and 403', async () => {
    const draft = await makeDraft();
    await kit.issued(draft.id);
    const issued = (await call({ method: 'GET', url: `/quotations/${draft.id}` }))
      .body as QuotationDto;
    for (const action of ['submit', 'issue', 'accept', 'reject']) {
      const url = `/quotations/${draft.id}/${action}`;
      expect((await call({ method: 'POST', url, body: {} })).status).toBe(400);
      expect((await call({ method: 'POST', url, user: NOBODY, body: { version: 1 } })).status).toBe(
        403,
      );
      expect(
        (
          await call({
            method: 'POST',
            url: `/quotations/${MISSING}/${action}`,
            body: { version: 1, acceptedByName: 'x', reason: 'x' },
          })
        ).status,
      ).toBe(404);
    }
    const stale = await call({
      method: 'POST',
      url: `/quotations/${draft.id}/accept`,
      body: { version: issued.version + 9, acceptedByName: 'x' },
    });
    expect(stale.status).toBe(409);
    expect(
      (await call({ method: 'POST', url: `/quotations/${draft.id}/revise`, user: ACCOUNTANT }))
        .status,
    ).toBe(403);
    expect((await call({ method: 'POST', url: `/quotations/${MISSING}/revise` })).status).toBe(404);
    const draft2 = await makeDraft();
    expect(
      (
        await call({
          method: 'POST',
          url: `/quotations/${draft2.id}/issue`,
          body: { version: draft2.version },
        })
      ).status,
    ).toBe(422);
  });
});

describe('print model and PDF (AC-3, BR-8)', () => {
  it('serves the print model and a PDF to readers, without internal cost or margin', async () => {
    const draft = await makeDraft();
    await kit.issued(draft.id);
    for (const user of [PM, MANAGEMENT, ACCOUNTANT]) {
      const model = await raw({ method: 'GET', url: `/quotations/${draft.id}/print-model`, user });
      expect(model.statusCode).toBe(200);
      expect(model.body).not.toMatch(/margin|cost|overhead|contingency/i);
      expect(model.json<{ price: string }>().price).toBe('1200.00');

      const pdf = await raw({ method: 'GET', url: `/quotations/${draft.id}/pdf`, user });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.headers['content-disposition']).toContain('.pdf');
      expect(pdf.rawPayload.subarray(0, 8).toString()).toBe('%PDF-1.4');
      expect(pdf.body).not.toMatch(/1000\.00|margin/i);
    }
  });

  it('answers 404, 400 and 403', async () => {
    const draft = await makeDraft();
    for (const suffix of ['print-model', 'pdf']) {
      expect((await call({ method: 'GET', url: `/quotations/${MISSING}/${suffix}` })).status).toBe(
        404,
      );
      expect((await call({ method: 'GET', url: `/quotations/nope/${suffix}` })).status).toBe(400);
      expect(
        (await call({ method: 'GET', url: `/quotations/${draft.id}/${suffix}`, user: NOBODY }))
          .status,
      ).toBe(403);
    }
  });
});
