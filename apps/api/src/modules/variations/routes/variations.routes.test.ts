import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  SUPERVISOR,
  SUPERVISOR2,
  createVariationsKit,
  eventCount,
  type VariationsKit,
} from '../test-support.js';
import type { ContractValueDto, PageResult, VariationDto, VariationHeaderDto } from '../types.js';

let kit: VariationsKit;
let projectId: string;
beforeAll(async () => {
  kit = await createVariationsKit();
  projectId = (await kit.project()).id;
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
const newKey = () => `var-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';

const body = (over: Record<string, unknown> = {}) => ({
  ...kit.input(),
  ...over,
});

const makeDraft = async (project = projectId) => {
  const response = await call({
    method: 'POST',
    url: `/projects/${project}/variations`,
    body: body(),
    key: newKey(),
  });
  expect(response.status).toBe(201);
  return response.body as VariationDto;
};

const post = (id: string, action: string, payload: object, user = PM) =>
  call({ method: 'POST', url: `/variations/${id}/${action}`, user, body: payload, key: newKey() });

describe('GET /projects/:id/variations', () => {
  it('lists for readers and refuses others', async () => {
    await makeDraft();
    for (const user of [PM, MANAGEMENT]) {
      const response = await call({
        method: 'GET',
        url: `/projects/${projectId}/variations`,
        user,
      });
      expect(response.status).toBe(200);
      expect((response.body as PageResult<VariationHeaderDto>).total).toBeGreaterThan(0);
    }
    for (const user of [SUPERVISOR, ACCOUNTANT, NOBODY]) {
      const response = await call({
        method: 'GET',
        url: `/projects/${projectId}/variations`,
        user,
      });
      expect(response.status).toBe(403);
    }
  });

  it('filters, pages and rejects bad queries', async () => {
    const draft = await makeDraft();
    const found = await call({
      method: 'GET',
      url: `/projects/${projectId}/variations?status=draft&limit=1`,
    });
    expect((found.body as PageResult<VariationHeaderDto>).items.map((v) => v.id)).toEqual([
      draft.id,
    ]);
    for (const query of ['limit=0', 'status=nope', 'offset=-1']) {
      expect(
        (await call({ method: 'GET', url: `/projects/${projectId}/variations?${query}` })).status,
      ).toBe(400);
    }
    expect((await call({ method: 'GET', url: `/projects/${MISSING}/variations` })).status).toBe(
      404,
    );
    expect((await call({ method: 'GET', url: '/projects/nope/variations' })).status).toBe(400);
  });
});

describe('POST /projects/:id/variations', () => {
  it('creates once for a repeated Idempotency-Key and refuses a changed body', async () => {
    const payload = body();
    const key = newKey();
    const url = `/projects/${projectId}/variations`;
    const first = await call({ method: 'POST', url, body: payload, key });
    const second = await call({ method: 'POST', url, body: payload, key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.body as VariationDto).id).toBe((first.body as VariationDto).id);
    const changed = await call({ method: 'POST', url, body: body({ title: 'Other' }), key });
    expect(changed.status).toBe(422);
    const empty = await call({ method: 'POST', url, body: payload, key: '' });
    expect(empty.status).toBe(400);
    expect(errorCode(empty)).toBe('invalid_idempotency_key');
  });

  it('validates the body, the references and the permission', async () => {
    const url = `/projects/${projectId}/variations`;
    const line = kit.input().lines[0];
    const badBodies = [
      body({ title: '' }),
      body({ lines: [] }),
      body({ discoveredOn: '20/10/2026' }),
      body({ lines: [{ ...line, costAmount: '1.234' }] }),
      body({ lines: [{ ...line, costCodeId: 'x' }] }),
      body({ lines: [{ ...line, description: '' }] }),
    ];
    for (const bad of badBodies) {
      expect((await call({ method: 'POST', url, body: bad })).status).toBe(400);
    }
    const negativeCost = await call({
      method: 'POST',
      url,
      body: body({ lines: [{ ...line, costAmount: '-1' }] }),
    });
    expect(negativeCost.status).toBe(400);
    expect(errorCode(negativeCost)).toBe('cost_amount_negative');
    expect(
      (await call({ method: 'POST', url: `/projects/${MISSING}/variations`, body: body() })).status,
    ).toBe(404);
    for (const user of [ACCOUNTANT, NOBODY]) {
      expect((await call({ method: 'POST', url, user, body: body() })).status).toBe(403);
    }
  });

  it('lets a supervisor create a draft on an assigned project only', async () => {
    const project = await kit.project();
    const url = `/projects/${project.id}/variations`;
    expect((await call({ method: 'POST', url, user: SUPERVISOR, body: body() })).status).toBe(404);
    await kit.assignSupervisor(project.id, SUPERVISOR);
    expect((await call({ method: 'POST', url, user: SUPERVISOR, body: body() })).status).toBe(201);
    expect((await call({ method: 'POST', url, user: SUPERVISOR2, body: body() })).status).toBe(404);
  });
});

describe('GET /variations/:id', () => {
  it('returns the variation with its lines, timeline and approval', async () => {
    const draft = await makeDraft();
    const response = await call({ method: 'GET', url: `/variations/${draft.id}` });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: draft.id,
      lines: [{ lineNo: 1, costAmount: '100.00', priceAmount: '150.00' }],
      history: [{ toStatus: 'draft' }],
      approval: { status: 'none' },
      atRisk: { total: '0.00', byCostCode: [] },
    });
  });

  it('answers 404 for an unknown id, 400 for a malformed one and 403 without permission', async () => {
    expect((await call({ method: 'GET', url: `/variations/${MISSING}` })).status).toBe(404);
    expect((await call({ method: 'GET', url: '/variations/nope' })).status).toBe(400);
    const draft = await makeDraft();
    expect(
      (await call({ method: 'GET', url: `/variations/${draft.id}`, user: NOBODY })).status,
    ).toBe(403);
  });
});

describe('PUT and DELETE /variations/:id', () => {
  it('updates with the expected version and answers a stale one with 409', async () => {
    const draft = await makeDraft();
    const ok = await call({
      method: 'PUT',
      url: `/variations/${draft.id}`,
      body: { ...body({ title: 'Renamed' }), version: draft.version },
      key: newKey(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: 'Renamed', version: draft.version + 1 });
    const stale = await call({
      method: 'PUT',
      url: `/variations/${draft.id}`,
      body: { ...body(), version: draft.version },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
  });

  it('refuses invalid input, unknown ids and missing permission', async () => {
    const draft = await makeDraft();
    const put = (id: string, payload: unknown, user = PM) =>
      call({ method: 'PUT', url: `/variations/${id}`, user, body: payload });
    expect((await put(draft.id, { ...body(), version: 0 })).status).toBe(400);
    expect((await put(draft.id, body())).status).toBe(400);
    expect((await put(MISSING, { ...body(), version: 1 })).status).toBe(404);
    expect((await put(draft.id, { ...body(), version: 1 }, ACCOUNTANT)).status).toBe(403);
    expect((await put(draft.id, { ...body(), version: 1 }, SUPERVISOR)).status).toBe(403);
  });

  it('deletes a draft with the expected version', async () => {
    const draft = await makeDraft();
    const url = `/variations/${draft.id}`;
    expect((await call({ method: 'DELETE', url: `${url}?version=9` })).status).toBe(409);
    expect((await call({ method: 'DELETE', url })).status).toBe(400);
    expect((await call({ method: 'DELETE', url: `${url}?version=1`, user: NOBODY })).status).toBe(
      403,
    );
    const ok = await call({ method: 'DELETE', url: `${url}?version=1`, key: newKey() });
    expect(ok.status).toBe(204);
    expect((await call({ method: 'GET', url })).status).toBe(404);
    expect((await call({ method: 'DELETE', url: `${url}?version=1` })).status).toBe(404);
  });
});

describe('the approval path over HTTP (AC-1, AC-2)', () => {
  it('cannot be sent to the client before the internal approval', async () => {
    const draft = await makeDraft();
    const early = await post(draft.id, 'send-to-client', { version: draft.version });
    expect(early.status).toBe(422);
    expect(errorCode(early)).toBe('variation_transition');
    const submitted = await post(draft.id, 'submit-internal', { version: draft.version });
    expect(submitted.status).toBe(200);
    expect((submitted.body as VariationDto).status).toBe('pending_internal_approval');
    const blocked = await post(draft.id, 'send-to-client', {
      version: (submitted.body as VariationDto).version,
    });
    expect(blocked.status).toBe(422);
    expect(errorCode(blocked)).toBe('internal_approval_required');
  });

  it('runs from draft to client approval and moves the contract value', async () => {
    const project = await kit.project();
    const draft = await makeDraft(project.id);
    const submitted = (await post(draft.id, 'submit-internal', { version: draft.version }))
      .body as VariationDto;
    await kit.decide(draft.id, 'approve');
    const sent = (await post(draft.id, 'send-to-client', { version: submitted.version }))
      .body as VariationDto;
    expect(sent.status).toBe('submitted_to_client');

    const approve = (payload: object, user = PM) => post(draft.id, 'client-approve', payload, user);
    const proof = { version: sent.version, reference: 'LTR-9', approvedOn: '2026-10-24' };
    const noDocument = await approve(proof);
    expect(errorCode(noDocument)).toBe('client_document_required');
    await kit.attachClientDocument(draft.id);
    expect((await approve({ ...proof, approvedOn: '24/10/2026' })).status).toBe(400);
    expect((await approve({ ...proof, reference: '' })).status).toBe(400);
    expect((await approve(proof, SUPERVISOR)).status).toBe(403);
    expect((await approve(proof, ACCOUNTANT)).status).toBe(403);
    const events = await eventCount(kit.db, 'variation.approved');
    const done = await approve(proof);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: 'client_approved',
      clientApprovalRef: 'LTR-9',
      clientApprovedOn: '2026-10-24',
    });
    expect(await eventCount(kit.db, 'variation.approved')).toBe(events + 1);
    expect((await approve(proof)).status).toBe(409);

    const value = await call({ method: 'GET', url: `/projects/${project.id}/contract-value` });
    expect(value.status).toBe(200);
    expect(value.body as ContractValueDto).toEqual({
      projectId: project.id,
      originalContractValue: '1000000.00',
      approvedPriceImpact: '150.00',
      currentContractValue: '1000150.00',
      approvedVariations: 1,
    });
    expect((await call({ method: 'GET', url: `/projects/${MISSING}/contract-value` })).status).toBe(
      404,
    );
    expect(
      (await call({ method: 'GET', url: `/projects/${project.id}/contract-value`, user: NOBODY }))
        .status,
    ).toBe(403);
  });

  it('records a rejection by the client and copies it into a new draft', async () => {
    const draft = await makeDraft();
    await kit.sent(draft.id);
    const version = await kit.version(draft.id);
    expect((await post(draft.id, 'client-reject', { version })).status).toBe(400);
    expect(
      (await post(draft.id, 'client-reject', { version, reason: 'No' }, ACCOUNTANT)).status,
    ).toBe(403);
    const events = await eventCount(kit.db, 'variation.rejected');
    const rejected = await post(draft.id, 'client-reject', { version, reason: 'Too dear' });
    expect(rejected.status).toBe(200);
    expect((rejected.body as VariationDto).status).toBe('client_rejected');
    expect(await eventCount(kit.db, 'variation.rejected')).toBe(events + 1);

    const copy = await call({
      method: 'POST',
      url: `/variations/${draft.id}/copy`,
      key: newKey(),
    });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ status: 'draft', copiedFromId: draft.id });
    expect(
      (await call({ method: 'POST', url: `/variations/${draft.id}/copy`, user: ACCOUNTANT }))
        .status,
    ).toBe(403);
    expect((await call({ method: 'POST', url: `/variations/${MISSING}/copy` })).status).toBe(404);
    const other = await makeDraft();
    expect((await call({ method: 'POST', url: `/variations/${other.id}/copy` })).status).toBe(422);
  });

  it('cancels and refuses stale versions and bad bodies', async () => {
    const draft = await makeDraft();
    expect((await post(draft.id, 'cancel', {})).status).toBe(400);
    expect((await post(draft.id, 'cancel', { version: 99 })).status).toBe(409);
    expect((await post(draft.id, 'cancel', { version: draft.version }, NOBODY)).status).toBe(403);
    expect((await post(MISSING, 'cancel', { version: 1 })).status).toBe(404);
    const done = await post(draft.id, 'cancel', { version: draft.version });
    expect(done.status).toBe(200);
    expect((done.body as VariationDto).status).toBe('cancelled');
    expect((await post(draft.id, 'submit-internal', { version: draft.version + 1 })).status).toBe(
      422,
    );
  });

  it('answers a repeated command with the first response', async () => {
    const draft = await makeDraft();
    const key = newKey();
    const url = `/variations/${draft.id}/submit-internal`;
    const first = await call({ method: 'POST', url, body: { version: draft.version }, key });
    const second = await call({ method: 'POST', url, body: { version: draft.version }, key });
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});
