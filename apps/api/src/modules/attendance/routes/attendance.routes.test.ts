import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTANT,
  FRIDAY,
  MANAGEMENT,
  NOBODY,
  PM,
  SUPERVISOR,
  SUPERVISOR2,
  THURSDAY,
  createAttendanceKit,
  type AttendanceKit,
  type Setup,
} from '../test-support.js';
import type { GridDto, MissingSheetDto, PageResult, SheetDto, SheetHeaderDto } from '../types.js';

vi.setConfig({ testTimeout: 60_000 });

let kit: AttendanceKit;
let setup: Setup;
beforeAll(async () => {
  kit = await createAttendanceKit();
  setup = await kit.setup();
}, 120_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
}

const call = async ({ method, url, user = SUPERVISOR, body, key }: Call) => {
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
const newKey = () => `att-key-${++keyCounter}`;
const MISSING = '018f0000-0000-7000-8000-000000000999';

const sheetUrl = (teamId: string, date: string) => `/attendance/sheets/${teamId}/${date}`;

describe('authentication and permissions', () => {
  it('refuses anonymous callers and callers without the permission', async () => {
    expect((await kit.app.inject({ method: 'GET', url: '/attendance/sheets' })).statusCode).toBe(
      401,
    );
    const saved = await kit.save(setup, FRIDAY, kit.body(setup));
    const probes: Omit<Call, 'user'>[] = [
      { method: 'GET', url: '/attendance/sheets' },
      { method: 'GET', url: `/attendance/sheets/${saved.id}` },
      { method: 'GET', url: `/attendance/grid?team=${setup.teamId}&date=${FRIDAY}` },
      { method: 'GET', url: `/attendance/missing?from=${FRIDAY}&to=${FRIDAY}` },
      { method: 'PUT', url: sheetUrl(setup.teamId, THURSDAY), body: { entries: [] } },
      { method: 'POST', url: `/attendance/sheets/${saved.id}/submit`, body: { version: 1 } },
      {
        method: 'POST',
        url: `/attendance/sheets/${saved.id}/unlock`,
        body: { reason: 'x', version: 1 },
      },
    ];
    for (const probe of probes) {
      const denied = await call({ ...probe, user: NOBODY });
      expect(denied.status, `${probe.method} ${probe.url}`).toBe(403);
    }
  });

  it('refuses unlock and write to holders of only the read permission', async () => {
    const saved = await kit.save(setup, THURSDAY, kit.body(setup));
    const unlock = await call({
      method: 'POST',
      url: `/attendance/sheets/${saved.id}/unlock`,
      user: SUPERVISOR,
      body: { reason: 'x', version: 1 },
    });
    expect(unlock.status).toBe(403);
    const write = await call({
      method: 'PUT',
      url: sheetUrl(setup.teamId, THURSDAY),
      user: ACCOUNTANT,
      body: { entries: [] },
    });
    expect(write.status).toBe(403);
    const submit = await call({
      method: 'POST',
      url: `/attendance/sheets/${saved.id}/submit`,
      user: MANAGEMENT,
      body: { version: saved.version },
    });
    expect(submit.status).toBe(403);
  });
});

describe('the flow of one sheet over HTTP (AC-1, AC-3)', () => {
  it('saves, submits, is approved and is unlocked again', async () => {
    const flow = await kit.setup();
    const entries = kit.body(flow).entries;
    const saved = await call({
      method: 'PUT',
      url: sheetUrl(flow.teamId, FRIDAY),
      body: { entries },
    });
    expect(saved.status).toBe(200);
    const sheet = saved.body as SheetDto;
    expect(sheet.status).toBe('draft');
    expect(sheet.total).toBeNull();

    const submitted = await call({
      method: 'POST',
      url: `/attendance/sheets/${sheet.id}/submit`,
      body: { version: sheet.version },
    });
    expect(submitted.status).toBe(200);
    expect((submitted.body as SheetDto).status).toBe('submitted');

    await kit.decide(sheet.id, 'approve');
    const fetched = await call({ method: 'GET', url: `/attendance/sheets/${sheet.id}`, user: PM });
    expect((fetched.body as SheetDto).status).toBe('approved');
    expect((fetched.body as SheetDto).total).toBe('2000.00');

    const unlocked = await call({
      method: 'POST',
      url: `/attendance/sheets/${sheet.id}/unlock`,
      user: PM,
      body: { reason: 'Wrong project', version: (fetched.body as SheetDto).version },
    });
    expect(unlocked.status).toBe(200);
    expect((unlocked.body as SheetDto).status).toBe('unlocked');
  });

  it('gives the grid, the list and the missing sheets', async () => {
    const flow = await kit.setup();
    const grid = await call({
      method: 'GET',
      url: `/attendance/grid?team=${flow.teamId}&date=${FRIDAY}`,
    });
    expect(grid.status).toBe(200);
    expect((grid.body as GridDto).sheet).toBeNull();
    expect((grid.body as GridDto).members).toHaveLength(2);

    await kit.save(flow, FRIDAY, kit.body(flow));
    const list = await call({
      method: 'GET',
      url: `/attendance/sheets?team=${flow.teamId}&date=${FRIDAY}&from=${FRIDAY}&to=${FRIDAY}&status=draft&limit=5&offset=0`,
    });
    expect(list.status).toBe(200);
    expect((list.body as PageResult<SheetHeaderDto>).items.map((s) => s.teamId)).toEqual([
      flow.teamId,
    ]);
    const defaults = await call({ method: 'GET', url: '/attendance/sheets', user: ACCOUNTANT });
    expect((defaults.body as PageResult<SheetHeaderDto>).limit).toBe(50);

    const missing = await call({
      method: 'GET',
      url: `/attendance/missing?from=${THURSDAY}&to=${FRIDAY}`,
    });
    expect(missing.status).toBe(200);
    expect((missing.body as MissingSheetDto[]).some((m) => m.teamId === flow.teamId)).toBe(true);
  });
});

describe('validation, not found and conflicts', () => {
  it('rejects malformed requests with a validation error', async () => {
    const bad: Call[] = [
      { method: 'GET', url: '/attendance/sheets?limit=0' },
      { method: 'GET', url: '/attendance/sheets?status=nonsense' },
      { method: 'GET', url: '/attendance/sheets/not-a-uuid' },
      { method: 'GET', url: '/attendance/grid?team=nope&date=2026-10-23' },
      { method: 'GET', url: `/attendance/grid?team=${setup.teamId}` },
      { method: 'GET', url: '/attendance/missing?from=2026-10-23' },
      { method: 'PUT', url: sheetUrl(setup.teamId, 'yesterday'), body: { entries: [] } },
      { method: 'PUT', url: sheetUrl(setup.teamId, FRIDAY), body: {} },
      {
        method: 'PUT',
        url: sheetUrl(setup.teamId, FRIDAY),
        body: { entries: [{ workerId: 'x', status: 'present' }] },
      },
      {
        method: 'PUT',
        url: sheetUrl(setup.teamId, FRIDAY),
        body: { entries: [{ workerId: setup.workerA.id, status: 'sick' }] },
      },
      { method: 'POST', url: `/attendance/sheets/${MISSING}/submit`, body: {} },
      {
        method: 'POST',
        url: `/attendance/sheets/${MISSING}/unlock`,
        body: { version: 1 },
        user: PM,
      },
    ];
    for (const request of bad) {
      const response = await call(request);
      expect(response.status, `${request.method} ${request.url}`).toBe(400);
    }
  });

  it('reports domain validation errors with their code', async () => {
    const flow = await kit.setup();
    const response = await call({
      method: 'PUT',
      url: sheetUrl(flow.teamId, FRIDAY),
      body: {
        entries: [
          {
            workerId: flow.workerA.id,
            status: 'present',
            allocations: [{ projectId: flow.projectA, fraction: '0.999' }],
          },
        ],
      },
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('allocation_sum');
  });

  it('answers not found for missing or foreign records', async () => {
    const flow = await kit.setup();
    const saved = await kit.save(flow, FRIDAY, kit.body(flow));
    for (const request of [
      { method: 'GET', url: `/attendance/sheets/${MISSING}` },
      { method: 'GET', url: `/attendance/sheets/${saved.id}`, user: SUPERVISOR2 },
      {
        method: 'GET',
        url: `/attendance/grid?team=${flow.teamId}&date=${FRIDAY}`,
        user: SUPERVISOR2,
      },
      { method: 'PUT', url: sheetUrl(MISSING, FRIDAY), body: { entries: [] } },
      {
        method: 'PUT',
        url: sheetUrl(flow.teamId, THURSDAY),
        body: { entries: [] },
        user: SUPERVISOR2,
      },
      { method: 'POST', url: `/attendance/sheets/${MISSING}/submit`, body: { version: 1 } },
      {
        method: 'POST',
        url: `/attendance/sheets/${MISSING}/unlock`,
        body: { reason: 'x', version: 1 },
        user: PM,
      },
    ] as Call[]) {
      const response = await call(request);
      expect(response.status, `${request.method} ${request.url}`).toBe(404);
    }
  });

  it('answers 409 for a stale version on save, submit and unlock', async () => {
    const flow = await kit.setup();
    const saved = (
      await call({ method: 'PUT', url: sheetUrl(flow.teamId, FRIDAY), body: kit.body(flow) })
    ).body as SheetDto;
    const noVersion = await call({
      method: 'PUT',
      url: sheetUrl(flow.teamId, FRIDAY),
      body: kit.body(flow),
    });
    expect(noVersion.status).toBe(409);
    const stale = await call({
      method: 'PUT',
      url: sheetUrl(flow.teamId, FRIDAY),
      body: { ...kit.body(flow), version: saved.version + 7 },
    });
    expect(stale.status).toBe(409);
    const submit = await call({
      method: 'POST',
      url: `/attendance/sheets/${saved.id}/submit`,
      body: { version: saved.version + 7 },
    });
    expect(submit.status).toBe(409);
    const approved = await kit.approved(flow, THURSDAY);
    const unlock = await call({
      method: 'POST',
      url: `/attendance/sheets/${approved.id}/unlock`,
      user: PM,
      body: { reason: 'x', version: approved.version + 7 },
    });
    expect(unlock.status).toBe(409);
  });

  it('refuses a rule violation with 422 and an empty reason with 400', async () => {
    const flow = await kit.setup();
    const approved = await kit.approved(flow, FRIDAY);
    const wrongState = await call({
      method: 'POST',
      url: `/attendance/sheets/${approved.id}/submit`,
      body: { version: approved.version },
    });
    expect(wrongState.status).toBe(422);
    expect(errorCode(wrongState)).toBe('sheet_transition');
    const noReason = await call({
      method: 'POST',
      url: `/attendance/sheets/${approved.id}/unlock`,
      user: PM,
      body: { reason: ' ', version: approved.version },
    });
    expect(noReason.status).toBe(400);
    expect(errorCode(noReason)).toBe('reason_required');
  });
});

describe('idempotent retry (constitution 10.3)', () => {
  it('replays the first response for the same Idempotency-Key and refuses a changed body', async () => {
    const flow = await kit.setup();
    const key = newKey();
    const request = {
      method: 'PUT' as const,
      url: sheetUrl(flow.teamId, FRIDAY),
      body: kit.body(flow),
      key,
    };
    const first = await call(request);
    const again = await call(request);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect((again.body as SheetDto).id).toBe((first.body as SheetDto).id);
    expect((again.body as SheetDto).version).toBe((first.body as SheetDto).version);

    // The same key with a different request is refused.
    const changed = await call({ ...request, body: { entries: [] } });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(changed.status).not.toBe(200);

    const submitKey = newKey();
    const submit = {
      method: 'POST' as const,
      url: `/attendance/sheets/${(first.body as SheetDto).id}/submit`,
      body: { version: (first.body as SheetDto).version },
      key: submitKey,
    };
    const one = await call(submit);
    const two = await call(submit);
    expect(one.status).toBe(200);
    expect(two.body).toEqual(one.body);

    const badKey = await kit.app.inject({
      method: 'PUT',
      url: sheetUrl(flow.teamId, THURSDAY),
      headers: { ...(await kit.auth(SUPERVISOR)), 'idempotency-key': '' },
      payload: { entries: [] },
    });
    expect(badKey.statusCode).toBe(400);
  });
});
