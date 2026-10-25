import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  JPEG,
  MANAGEMENT,
  NOBODY,
  PM,
  SUPERVISOR,
  createCrmKit,
  type CrmKit,
} from '../test-support.js';
import type { FollowUpDto, LeadDetailDto, LeadDto, VisitDto } from '../types.js';

let kit: CrmKit;
beforeAll(async () => {
  kit = await createCrmKit();
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
const newKey = () => `crm-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';

const leadBody = {
  contactName: 'Route Client',
  contactPhone: '03001112233',
  workType: 'renovation',
  sector: 'private',
  sourceCode: 'walk_in',
  expectedValue: '1200000',
};

const makeLead = async (overrides: Record<string, unknown> = {}) => {
  const response = await call({
    method: 'POST',
    url: '/crm/leads',
    body: { ...leadBody, ...overrides },
    key: newKey(),
  });
  expect(response.status).toBe(201);
  return response.body as LeadDto;
};

describe('authorization (spec section 6, BR-9)', () => {
  const requests: Omit<Call, 'user'>[] = [
    { method: 'GET', url: '/crm/reference' },
    { method: 'GET', url: '/crm/leads' },
    { method: 'GET', url: `/crm/leads/${MISSING}` },
    { method: 'POST', url: '/crm/leads', body: leadBody },
    { method: 'PUT', url: `/crm/leads/${MISSING}`, body: { ...leadBody, version: 1 } },
    { method: 'DELETE', url: `/crm/leads/${MISSING}?version=1` },
    {
      method: 'POST',
      url: `/crm/leads/${MISSING}/stage`,
      body: { stageCode: 'visited', version: 1 },
    },
    { method: 'POST', url: `/crm/leads/${MISSING}/visits`, body: { visitDate: '2026-10-01' } },
    { method: 'POST', url: `/crm/leads/${MISSING}/follow-ups`, body: { dueDate: '2026-11-01' } },
    { method: 'GET', url: '/crm/follow-ups' },
    { method: 'POST', url: `/crm/follow-ups/${MISSING}/done`, body: { version: 1 } },
    { method: 'GET', url: '/crm/pipeline' },
  ];

  it('denies supervisors and users without permissions everywhere', async () => {
    for (const request of requests) {
      for (const user of [SUPERVISOR, NOBODY]) {
        const response = await call({ ...request, user });
        expect(response.status, `${request.method} ${request.url} as ${user}`).toBe(403);
      }
    }
  });

  it('lets the accountant read but not change', async () => {
    for (const request of requests) {
      const response = await call({ ...request, user: ACCOUNTANT });
      if (request.method === 'GET') {
        expect(response.status, request.url).not.toBe(403);
      } else {
        expect(response.status, `${request.method} ${request.url}`).toBe(403);
      }
    }
  });

  it('requires a signed-in user', async () => {
    const response = await kit.app.inject({ method: 'GET', url: '/crm/leads' });
    expect(response.statusCode).toBe(401);
  });
});

describe('leads', () => {
  it('creates, reads, lists and updates a lead', async () => {
    const lead = await makeLead({ description: 'Kitchen and two bathrooms' });
    expect(lead).toMatchObject({ stageCode: 'new', ownerUserId: PM });

    const detail = await call({ method: 'GET', url: `/crm/leads/${lead.id}` });
    expect(detail.status).toBe(200);
    expect((detail.body as LeadDetailDto).lead.id).toBe(lead.id);
    expect((detail.body as LeadDetailDto).history).toHaveLength(1);

    const list = await call({
      method: 'GET',
      url: '/crm/leads?q=Route%20Client&sector=private&stageCode=new&sort=value&direction=asc&limit=5&overdue=false',
      user: ACCOUNTANT,
    });
    expect(list.status).toBe(200);
    expect((list.body as { items: LeadDto[] }).items.map((l) => l.id)).toContain(lead.id);

    const updated = await call({
      method: 'PUT',
      url: `/crm/leads/${lead.id}`,
      body: { ...leadBody, sector: 'government', version: lead.version },
      key: newKey(),
    });
    expect(updated.status).toBe(200);
    expect((updated.body as LeadDto).sector).toBe('government');

    const reference = await call({ method: 'GET', url: '/crm/reference', user: ACCOUNTANT });
    expect(reference.status).toBe(200);
  });

  it('rejects invalid bodies and queries', async () => {
    const bad = [
      { ...leadBody, sector: 'ngo' },
      { ...leadBody, workType: 'tower' },
      { ...leadBody, expectedValue: '12.345' },
      { ...leadBody, sourceCode: '' },
      { ...leadBody, partyId: 'not-a-uuid' },
    ];
    for (const body of bad) {
      const response = await call({ method: 'POST', url: '/crm/leads', body, key: newKey() });
      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe('validation_failed');
    }
    expect((await call({ method: 'GET', url: '/crm/leads?limit=0' })).status).toBe(400);
    expect((await call({ method: 'GET', url: '/crm/leads/not-a-uuid' })).status).toBe(400);
    const noContact = await call({
      method: 'POST',
      url: '/crm/leads',
      body: { ...leadBody, contactPhone: null },
      key: newKey(),
    });
    expect(noContact.status).toBe(400);
    expect(errorCode(noContact)).toBe('contact_required');
  });

  it('answers 404 for a missing lead', async () => {
    expect((await call({ method: 'GET', url: `/crm/leads/${MISSING}` })).status).toBe(404);
    const update = await call({
      method: 'PUT',
      url: `/crm/leads/${MISSING}`,
      body: { ...leadBody, version: 1 },
    });
    expect(update.status).toBe(404);
    expect((await call({ method: 'DELETE', url: `/crm/leads/${MISSING}?version=1` })).status).toBe(
      404,
    );
  });

  it('answers 409 on a version conflict', async () => {
    const lead = await makeLead();
    const update = await call({
      method: 'PUT',
      url: `/crm/leads/${lead.id}`,
      body: { ...leadBody, version: lead.version + 4 },
    });
    expect(update.status).toBe(409);
    expect(errorCode(update)).toBe('version_conflict');
    const remove = await call({ method: 'DELETE', url: `/crm/leads/${lead.id}?version=9` });
    expect(remove.status).toBe(409);
    const stage = await call({
      method: 'POST',
      url: `/crm/leads/${lead.id}/stage`,
      body: { stageCode: 'visited', version: 9 },
    });
    expect(stage.status).toBe(409);
  });

  it('replays an idempotent create and rejects a changed body under the same key', async () => {
    const key = newKey();
    const first = await call({ method: 'POST', url: '/crm/leads', body: leadBody, key });
    const second = await call({ method: 'POST', url: '/crm/leads', body: leadBody, key });
    expect(second.status).toBe(201);
    expect((second.body as LeadDto).id).toBe((first.body as LeadDto).id);
    const changed = await call({
      method: 'POST',
      url: '/crm/leads',
      body: { ...leadBody, contactName: 'Someone Else' },
      key,
    });
    expect(changed.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a malformed Idempotency-Key header', async () => {
    const response = await kit.app.inject({
      method: 'POST',
      url: '/crm/leads',
      headers: { ...(await kit.auth(PM)), 'idempotency-key': '' },
      payload: leadBody,
    });
    expect(response.statusCode).toBe(400);
  });

  it('deletes an open lead (204) and replays the retry', async () => {
    const lead = await makeLead();
    const key = newKey();
    const url = `/crm/leads/${lead.id}?version=${lead.version}`;
    expect((await call({ method: 'DELETE', url, key })).status).toBe(204);
    expect((await call({ method: 'DELETE', url, key })).status).toBe(204);
    expect((await call({ method: 'GET', url: `/crm/leads/${lead.id}` })).status).toBe(404);
  });
});

describe('stage changes', () => {
  it('moves a lead to won with a created client and reopens only with the permission', async () => {
    const lead = await makeLead({ contactPhone: '03007776655' });
    const url = `/crm/leads/${lead.id}/stage`;

    const lostWithoutReason = await call({
      method: 'POST',
      url,
      body: { stageCode: 'lost', version: lead.version },
    });
    expect(lostWithoutReason.status).toBe(400);
    expect(errorCode(lostWithoutReason)).toBe('loss_reason_required');

    const key = newKey();
    const won = await call({
      method: 'POST',
      url,
      body: { stageCode: 'won', version: lead.version },
      key,
    });
    expect(won.status).toBe(200);
    const wonLead = won.body as LeadDto;
    expect(wonLead).toMatchObject({ stageKind: 'won' });
    expect(wonLead.partyId).not.toBeNull();
    const replay = await call({
      method: 'POST',
      url,
      body: { stageCode: 'won', version: lead.version },
      key,
    });
    expect((replay.body as LeadDto).version).toBe(wonLead.version);

    const noReopen = await call({
      method: 'POST',
      url,
      body: { stageCode: 'new', version: wonLead.version },
      key: newKey(),
    });
    expect(noReopen.status).toBe(422);
    expect(errorCode(noReopen)).toBe('lead_closed');

    const reopened = await call({
      method: 'POST',
      url,
      user: MANAGEMENT,
      body: { stageCode: 'new', version: wonLead.version },
      key: newKey(),
    });
    expect(reopened.status).toBe(200);
    expect((reopened.body as LeadDto).stageKind).toBe('open');

    const missing = await call({
      method: 'POST',
      url: `/crm/leads/${MISSING}/stage`,
      body: { stageCode: 'visited', version: 1 },
    });
    expect(missing.status).toBe(404);
    const invalid = await call({ method: 'POST', url, body: { stageCode: '', version: 1 } });
    expect(invalid.status).toBe(400);
  });

  it('loses a lead with a reason', async () => {
    const lead = await makeLead();
    const lost = await call({
      method: 'POST',
      url: `/crm/leads/${lead.id}/stage`,
      body: { stageCode: 'lost', lossReasonCode: 'competitor', version: lead.version },
      key: newKey(),
    });
    expect(lost.status).toBe(200);
    expect(lost.body).toMatchObject({ stageKind: 'lost', lossReasonCode: 'competitor' });
  });
});

describe('visits and follow-ups', () => {
  it('records a visit and rejects a future date and a missing lead', async () => {
    const lead = await makeLead();
    const url = `/crm/leads/${lead.id}/visits`;
    const key = newKey();
    const visit = await call({
      method: 'POST',
      url,
      body: { visitDate: '2026-10-20', notes: 'Measured' },
      key,
    });
    expect(visit.status).toBe(201);
    const replay = await call({
      method: 'POST',
      url,
      body: { visitDate: '2026-10-20', notes: 'Measured' },
      key,
    });
    expect((replay.body as VisitDto).id).toBe((visit.body as VisitDto).id);

    const future = await call({
      method: 'POST',
      url,
      body: { visitDate: '2030-01-01' },
      key: newKey(),
    });
    expect(future.status).toBe(422);
    expect(errorCode(future)).toBe('visit_in_future');
    expect((await call({ method: 'POST', url, body: { visitDate: 'yesterday' } })).status).toBe(
      400,
    );
    expect(
      (
        await call({
          method: 'POST',
          url: `/crm/leads/${MISSING}/visits`,
          body: { visitDate: '2026-10-20' },
        })
      ).status,
    ).toBe(404);
  });

  it('manages site visit photos through the shared files module (BR-7)', async () => {
    const lead = await makeLead();
    const visit = (
      await call({
        method: 'POST',
        url: `/crm/leads/${lead.id}/visits`,
        body: { visitDate: '2026-10-20' },
        key: newKey(),
      })
    ).body as VisitDto;
    const actorOf = (userId: string, permissions: string[]) => ({
      userId,
      roles: [],
      scopes: [],
      permissions: new Set(['files.attachment.upload', 'files.attachment.read', ...permissions]),
      requestId: null,
    });
    const manager = actorOf(PM, ['crm.visit.manage', 'crm.lead.read']);
    const attached = await kit.db.transaction((tx) =>
      kit.files.attach(
        { entityType: 'crm_site_visit', entityId: visit.id, fileName: 'plot.jpg', bytes: JPEG },
        manager,
        tx,
      ),
    );
    expect(attached.created).toBe(true);
    const reader = actorOf(ACCOUNTANT, ['crm.lead.read']);
    expect(await kit.files.list(kit.db, reader, 'crm_site_visit', visit.id)).toHaveLength(1);
    await expect(
      kit.db.transaction((tx) =>
        kit.files.attach(
          { entityType: 'crm_site_visit', entityId: visit.id, fileName: 'x.jpg', bytes: JPEG },
          reader,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'entity_not_found' });
    await expect(kit.files.list(kit.db, manager, 'crm_site_visit', MISSING)).rejects.toMatchObject({
      code: 'entity_not_found',
    });
  });

  it('creates, lists and completes follow-ups with conflict and not-found answers', async () => {
    const lead = await makeLead();
    const url = `/crm/leads/${lead.id}/follow-ups`;
    const key = newKey();
    const created = await call({
      method: 'POST',
      url,
      body: { dueDate: '2026-11-05', note: 'Send drawings', assignedTo: ADMIN },
      key,
    });
    expect(created.status).toBe(201);
    const followUp = created.body as FollowUpDto;
    const replay = await call({
      method: 'POST',
      url,
      body: { dueDate: '2026-11-05', note: 'Send drawings', assignedTo: ADMIN },
      key,
    });
    expect((replay.body as FollowUpDto).id).toBe(followUp.id);

    const duplicate = await call({
      method: 'POST',
      url,
      body: { dueDate: '2026-11-05', assignedTo: ADMIN },
      key: newKey(),
    });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate)).toBe('follow_up_exists');
    expect((await call({ method: 'POST', url, body: { dueDate: '05/11/2026' } })).status).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          url: `/crm/leads/${MISSING}/follow-ups`,
          body: { dueDate: '2026-11-05' },
        })
      ).status,
    ).toBe(404);

    const list = await call({
      method: 'GET',
      url: `/crm/follow-ups?leadId=${lead.id}&assignedTo=${ADMIN}&status=open&limit=10&offset=0`,
      user: ACCOUNTANT,
    });
    expect(list.status).toBe(200);
    expect((list.body as { items: FollowUpDto[] }).items.map((f) => f.id)).toEqual([followUp.id]);
    expect((await call({ method: 'GET', url: '/crm/follow-ups?status=late' })).status).toBe(400);

    const doneUrl = `/crm/follow-ups/${followUp.id}/done`;
    const stale = await call({ method: 'POST', url: doneUrl, body: { version: 9 } });
    expect(stale.status).toBe(409);
    const doneKey = newKey();
    const done = await call({
      method: 'POST',
      url: doneUrl,
      body: { version: followUp.version },
      key: doneKey,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'done' });
    const doneReplay = await call({
      method: 'POST',
      url: doneUrl,
      body: { version: followUp.version },
      key: doneKey,
    });
    expect(doneReplay.status).toBe(200);
    expect(
      (await call({ method: 'POST', url: `/crm/follow-ups/${MISSING}/done`, body: { version: 1 } }))
        .status,
    ).toBe(404);
    expect((await call({ method: 'POST', url: doneUrl, body: {} })).status).toBe(400);
  });
});

describe('pipeline', () => {
  it('returns counts and expected value per stage', async () => {
    const response = await call({ method: 'GET', url: '/crm/pipeline', user: ACCOUNTANT });
    expect(response.status).toBe(200);
    const body = response.body as {
      stages: { stageCode: string; count: number }[];
      totalCount: number;
    };
    expect(body.stages.reduce((n, s) => n + s.count, 0)).toBe(body.totalCount);
  });
});
