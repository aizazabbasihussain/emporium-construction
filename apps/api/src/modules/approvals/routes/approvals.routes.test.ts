import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  ESTIMATOR,
  OWNER,
  PM,
  PM2,
  SUPERVISOR,
  createApprovalsKit,
  twoStepRules,
  type ApprovalsKit,
} from '../test-support.js';

let k: ApprovalsKit;

beforeAll(async () => {
  k = await createApprovalsKit();
  await k.seedTestDoc();
}, 60_000);

afterAll(async () => {
  await k.close();
});

interface Json {
  id: string;
  docId: string;
  status: string;
  currentStep: number;
  version: number;
  error: { code: string };
  items: Json[];
  sets: { bands: unknown[] }[];
  actions: unknown[];
  steps: unknown[];
}

const call = async (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  options: { as?: string | null; body?: unknown; key?: string } = {},
) => {
  const as = options.as === undefined ? ADMIN : options.as;
  const response = await k.app.inject({
    method,
    url,
    headers: {
      ...(as === null ? {} : { authorization: `Bearer ${await k.token(as)}` }),
      ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
    },
    payload: options.body as object,
  });
  return { status: response.statusCode, body: response.json<Json>() };
};

const submit = async (amount = '10', context: Record<string, unknown> = {}, as: string = ADMIN) =>
  call('POST', '/approvals/requests', {
    as,
    body: { docType: 'test_doc', docId: k.newDoc(), amount, requesterId: ESTIMATOR, context },
  });

describe('POST /approvals/requests', () => {
  it('creates a request (201) for the caller by default', async () => {
    const docId = k.newDoc();
    const { status, body } = await call('POST', '/approvals/requests', {
      body: { docType: 'test_doc', docId, amount: '250000' },
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      docType: 'test_doc',
      docId,
      requesterId: ADMIN,
      status: 'pending',
      revision: 1,
      amount: '250000.00',
    });
    expect(body.steps).toHaveLength(2);
  });

  it('rejects invalid input with 400', async () => {
    for (const body of [
      { docType: 'Bad Type', docId: k.newDoc(), amount: '1' },
      { docType: 'test_doc', docId: 'nope', amount: '1' },
      { docType: 'test_doc', docId: k.newDoc(), amount: '1.234' },
      { docType: 'test_doc', docId: k.newDoc(), amount: '-1' },
      {},
    ]) {
      expect((await call('POST', '/approvals/requests', { body })).status).toBe(400);
    }
  });

  it('refuses without a matching rule (422) and without permission (403, 401)', async () => {
    const noRule = await call('POST', '/approvals/requests', {
      body: { docType: 'unknown_doc', docId: k.newDoc(), amount: '1' },
    });
    expect(noRule.status).toBe(422);
    expect(noRule.body.error.code).toBe('no_approval_rule');
    const body = { docType: 'test_doc', docId: k.newDoc(), amount: '1' };
    expect((await call('POST', '/approvals/requests', { as: PM, body })).status).toBe(403);
    expect((await call('POST', '/approvals/requests', { as: null, body })).status).toBe(401);
  });

  it('replays an idempotent retry and rejects a reused key with another body', async () => {
    const body = { docType: 'test_doc', docId: k.newDoc(), amount: '5' };
    const first = await call('POST', '/approvals/requests', { body, key: 'k-submit-1' });
    const again = await call('POST', '/approvals/requests', { body, key: 'k-submit-1' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    const other = await call('POST', '/approvals/requests', {
      body: { ...body, amount: '6' },
      key: 'k-submit-1',
    });
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('idempotency_key_reused');
    expect((await call('POST', '/approvals/requests', { body, key: '' })).body.error.code).toBe(
      'invalid_idempotency_key',
    );
    const duplicate = await call('POST', '/approvals/requests', { body });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('open_request_exists');
  });
});

describe('GET /approvals/requests/:id', () => {
  it('returns a request to its requester, an approver and an admin', async () => {
    const created = (await submit('10', {}, ADMIN)).body;
    const asApprover = await call('GET', `/approvals/requests/${created.id}`, { as: PM });
    expect(asApprover.status).toBe(200);
    expect(asApprover.body.id).toBe(created.id);
    expect((await call('GET', `/approvals/requests/${created.id}`)).status).toBe(200);
    const own = await call('POST', '/approvals/requests', {
      body: { docType: 'test_doc', docId: k.newDoc(), amount: '1', requesterId: ESTIMATOR },
    });
    expect(
      (await call('GET', `/approvals/requests/${own.body.id}`, { as: ESTIMATOR })).status,
    ).toBe(200);
  });

  it('answers 404 for unknown ids and strangers, 400 for a bad id, 401 without a token', async () => {
    const created = (await submit()).body;
    expect(
      (await call('GET', '/approvals/requests/018f0000-0000-7000-8000-00000000dead')).status,
    ).toBe(404);
    expect(
      (await call('GET', `/approvals/requests/${created.id}`, { as: ACCOUNTANT })).status,
    ).toBe(404);
    expect((await call('GET', '/approvals/requests/not-a-uuid')).status).toBe(400);
    expect((await call('GET', `/approvals/requests/${created.id}`, { as: null })).status).toBe(401);
    expect(
      (await call('GET', `/approvals/requests/${created.id}`, { as: SUPERVISOR })).status,
    ).toBe(404);
  });
});

describe('GET /approvals/inbox', () => {
  it('lists requests waiting for the caller', async () => {
    const created = (await submit()).body;
    const inbox = await call('GET', '/approvals/inbox', { as: PM });
    expect(inbox.status).toBe(200);
    expect(inbox.body.items.map((r: Json) => r.id)).toContain(created.id);
    const other = await call('GET', '/approvals/inbox', { as: ACCOUNTANT });
    expect(other.body.items.map((r: Json) => r.id)).not.toContain(created.id);
  });

  it('needs the inbox permission', async () => {
    expect((await call('GET', '/approvals/inbox', { as: ESTIMATOR })).status).toBe(403);
    expect((await call('GET', '/approvals/inbox', { as: null })).status).toBe(401);
  });
});

describe('POST /approvals/requests/:id/approve|reject|return', () => {
  it('approves through two steps (AC-1) and sends the request to history', async () => {
    const created = (await submit('250000')).body;
    const url = `/approvals/requests/${created.id}`;
    expect((await call('POST', `${url}/approve`, { as: PM })).body.currentStep).toBe(1);
    expect((await call('POST', `${url}/approve`, { as: PM2 })).body.currentStep).toBe(2);
    const done = await call('POST', `${url}/approve`, { as: OWNER, body: { comment: 'ok' } });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('approved');
  });

  it('reject and return need a comment and end the request', async () => {
    const a = (await submit()).body;
    const noComment = await call('POST', `/approvals/requests/${a.id}/reject`, { as: PM });
    expect(noComment.status).toBe(400);
    expect(noComment.body.error.code).toBe('comment_required');
    const rejected = await call('POST', `/approvals/requests/${a.id}/reject`, {
      as: PM,
      body: { comment: 'too expensive' },
    });
    expect(rejected.body.status).toBe('rejected');
    const b = (await submit()).body;
    const returned = await call('POST', `/approvals/requests/${b.id}/return`, {
      as: PM,
      body: { comment: 'fix it' },
    });
    expect(returned.body.status).toBe('returned');
  });

  it('forbids the requester, wrong roles and missing permission', async () => {
    const created = (await submit('10', {}, ADMIN)).body;
    const url = `/approvals/requests/${created.id}/approve`;
    const own = await call('POST', '/approvals/requests', {
      body: { docType: 'test_doc', docId: k.newDoc(), amount: '10', requesterId: PM },
    });
    const self = await call('POST', `/approvals/requests/${own.body.id}/approve`, { as: PM });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_approval');
    expect((await call('POST', url, { as: ACCOUNTANT })).body.error.code).toBe('not_an_approver');
    expect((await call('POST', url, { as: ESTIMATOR })).status).toBe(403);
    expect((await call('POST', url, { as: null })).status).toBe(401);
  });

  it('answers 404 for unknown requests and 400 for malformed bodies', async () => {
    expect(
      (
        await call('POST', '/approvals/requests/018f0000-0000-7000-8000-00000000dead/approve', {
          as: PM,
        })
      ).status,
    ).toBe(404);
    const created = (await submit()).body;
    expect(
      (
        await call('POST', `/approvals/requests/${created.id}/approve`, {
          as: PM,
          body: { version: 0 },
        })
      ).status,
    ).toBe(400);
  });

  it('answers 409 on a version conflict and 422 on a finished request', async () => {
    const created = (await submit()).body;
    const url = `/approvals/requests/${created.id}/approve`;
    const stale = await call('POST', url, { as: PM, body: { version: created.version + 5 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect((await call('POST', url, { as: PM, body: { version: created.version } })).status).toBe(
      200,
    );
    const finished = await call('POST', url, { as: PM2 });
    expect(finished.status).toBe(422);
    expect(finished.body.error.code).toBe('request_not_pending');
  });

  it('replays an idempotent retry without a second action', async () => {
    const created = (await submit()).body;
    const url = `/approvals/requests/${created.id}/approve`;
    const first = await call('POST', url, { as: PM, key: 'k-approve-1' });
    const again = await call('POST', url, { as: PM, key: 'k-approve-1' });
    expect(first.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(again.body.actions).toHaveLength(1);
    expect(await k.eventsFor(created.docId)).toEqual(['approval.requested', 'approval.approved']);
  });
});

describe('approval rules endpoints', () => {
  it('lists document types and returns rule sets', async () => {
    const types = await call('GET', '/admin/approval-rules', { as: OWNER });
    expect(types.status).toBe(200);
    expect(types.body.items).toEqual(expect.arrayContaining(['purchase_order', 'test_doc']));
    const rules = await call('GET', '/admin/approval-rules/purchase_order', { as: OWNER });
    expect(rules.body).toEqual({
      docType: 'purchase_order',
      sets: [
        {
          effectiveFrom: '2026-01-01',
          bands: [
            {
              minAmount: '0.00',
              maxAmount: null,
              steps: [{ stepNo: 1, roleCode: 'management', minApprovers: 1 }],
            },
          ],
        },
      ],
    });
    expect((await call('GET', '/admin/approval-rules/nothing_here')).body.sets).toEqual([]);
  });

  it('replaces rules, validates them and needs the manage permission', async () => {
    const put = (body: unknown, as: string | null = ADMIN, key?: string) =>
      call('PUT', '/admin/approval-rules/edited_doc', {
        as,
        body,
        ...(key === undefined ? {} : { key }),
      });
    const ok = await put(twoStepRules(), ADMIN, 'k-rules-1');
    expect(ok.status).toBe(200);
    expect(ok.body.sets[0]?.bands).toHaveLength(2);
    expect((await put(twoStepRules(), ADMIN, 'k-rules-1')).body).toEqual(ok.body);
    const overlap = await put({
      effectiveFrom: '2026-01-01',
      bands: [
        { minAmount: '0', maxAmount: '10', steps: [{ stepNo: 1, roleCode: 'management' }] },
        { minAmount: '5', maxAmount: null, steps: [{ stepNo: 1, roleCode: 'management' }] },
      ],
    });
    expect(overlap.status).toBe(400);
    expect(overlap.body.error.code).toBe('band_overlap');
    expect((await put({ effectiveFrom: 'soon', bands: [] })).status).toBe(400);
    expect((await put(twoStepRules(), PM)).status).toBe(403);
    expect((await put(twoStepRules(), null)).status).toBe(401);
    expect((await call('GET', '/admin/approval-rules/edited_doc', { as: PM })).status).toBe(403);
    expect((await call('GET', '/admin/approval-rules/Bad-Type')).status).toBe(400);
  });
});
