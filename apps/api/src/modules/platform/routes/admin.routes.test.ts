import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import { createLogger } from '../../../logger.js';
import { platformPermissions, platformPermissionGrants } from '@emporium/shared';
import type { Principal } from '../types.js';
import { ADMIN_ID, OTHER_ID, createKernel, principal, type Kernel } from '../test-support.js';

let k: Kernel;
let app: FastifyInstance;
let caller: Principal | null;

const everything = principal(ADMIN_ID, ...Object.values(platformPermissions));

beforeAll(async () => {
  k = await createKernel();
  app = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => k.clock.now(),
    platform: {
      db: k.db,
      platform: k.platform,
      resolvePrincipal: (request) => {
        const who = request.headers['x-test-user'];
        if (who === 'none') return null;
        return who === 'other' ? principal(OTHER_ID) : caller;
      },
    },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
});

const call = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  options: { body?: unknown; headers?: Record<string, string>; as?: Principal | null } = {},
) => {
  caller = options.as === undefined ? everything : options.as;
  return app.inject({ method, url, payload: options.body as object, headers: options.headers });
};

describe('permissions on every endpoint', () => {
  const cases: [string, string, unknown, string][] = [
    ['GET', '/admin/audit', undefined, platformPermissions.auditRead],
    ['GET', '/admin/outbox/failed', undefined, platformPermissions.outboxManage],
    [
      'POST',
      '/admin/outbox/018f0000-0000-7000-8000-000000000001/retry',
      undefined,
      platformPermissions.outboxManage,
    ],
    ['GET', '/admin/settings/backdating_days', undefined, platformPermissions.settingsManage],
    [
      'PUT',
      '/admin/settings/backdating_days',
      { value: 4, version: 1 },
      platformPermissions.settingsManage,
    ],
    ['GET', '/admin/number-series', undefined, platformPermissions.seriesManage],
    [
      'POST',
      '/admin/number-series',
      { code: 'x', prefix: 'X', padding: 3, resetYearly: false, gapless: false, startValue: 1 },
      platformPermissions.seriesManage,
    ],
  ];

  it.each(cases)('%s %s: 401 without a caller, 403 without %s', async (method, url, body, perm) => {
    const anonymous = await call(method as 'GET', url, { body, as: null });
    expect(anonymous.statusCode).toBe(401);
    const denied = await call(method as 'GET', url, {
      body,
      as: principal(OTHER_ID, ...Object.values(platformPermissions).filter((p) => p !== perm)),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('grants match the spec: admin and accountant read audit; only admin overrides backdating', () => {
    expect(platformPermissionGrants['platform.audit.read']).toEqual(['admin', 'accountant']);
    expect(platformPermissionGrants['platform.series.manage']).toEqual(['admin', 'accountant']);
    expect(platformPermissionGrants['platform.backdate.override']).toEqual(['admin']);
  });
});

describe('GET /admin/audit', () => {
  it('filters by entity, actor and date range', async () => {
    await k.db.transaction((tx) =>
      k.platform.audit.record(
        { actorUserId: ADMIN_ID, action: 'doc.create', entityType: 'doc', entityId: 'd1' },
        tx,
      ),
    );
    const url = `/admin/audit?entityType=doc&entityId=d1&actorUserId=${ADMIN_ID}&from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`;
    const response = await call('GET', url);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toHaveLength(1);
    const none = await call('GET', '/admin/audit?entityType=nothing');
    expect(none.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('rejects invalid filters', async () => {
    expect((await call('GET', '/admin/audit?actorUserId=not-a-uuid')).statusCode).toBe(400);
    expect((await call('GET', '/admin/audit?limit=0')).statusCode).toBe(400);
    expect((await call('GET', '/admin/audit?from=yesterday')).statusCode).toBe(400);
  });
});

describe('outbox admin', () => {
  const eventId = '018f0000-0000-7000-8000-0000000000aa';

  it('lists failed events and retries one, with idempotent replay', async () => {
    expect((await call('GET', '/admin/outbox/failed')).json<{ items: unknown[] }>().items).toEqual(
      [],
    );
    await k.db.query(
      `insert into sys_outbox (id, type, payload, attempts, failed_at, last_error)
       values ($1, 't', '{}', 5, now(), 'down')`,
      [eventId],
    );
    expect(
      (await call('GET', '/admin/outbox/failed')).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);

    const headers = { 'idempotency-key': 'retry-1' };
    const first = await call('POST', `/admin/outbox/${eventId}/retry`, { headers });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ attempts: number }>().attempts).toBe(0);
    const replay = await call('POST', `/admin/outbox/${eventId}/retry`, { headers });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const audits = await k.platform.audit.search(k.db, {
      entityType: 'outbox_event',
      limit: 5,
      offset: 0,
    });
    expect(audits).toHaveLength(1);
  });

  it('answers 400 for a bad id, 404 for an unknown event and 400 for one that has not failed', async () => {
    expect((await call('POST', '/admin/outbox/nope/retry')).statusCode).toBe(400);
    expect(
      (await call('POST', '/admin/outbox/018f0000-0000-7000-8000-0000000000bb/retry')).statusCode,
    ).toBe(404);
    expect((await call('POST', `/admin/outbox/${eventId}/retry`)).statusCode).toBe(400);
  });
});

describe('settings admin', () => {
  it('reads, updates, replays, and reports validation, conflict and unknown key', async () => {
    const read = await call('GET', '/admin/settings/backdating_days');
    expect(read.json()).toMatchObject({ value: 3, version: 1 });

    const headers = { 'idempotency-key': 'set-1' };
    const body = { value: 5, version: 1 };
    const first = await call('PUT', '/admin/settings/backdating_days', { body, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ value: 5, version: 2 });
    const replay = await call('PUT', '/admin/settings/backdating_days', { body, headers });
    expect(replay.json()).toEqual(first.json());
    expect(replay.statusCode).toBe(200);

    const reused = await call('PUT', '/admin/settings/backdating_days', {
      body: { value: 6, version: 2 },
      headers,
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_reused');

    const stale = await call('PUT', '/admin/settings/backdating_days', {
      body: { value: 6, version: 1 },
    });
    expect(stale.statusCode).toBe(409);

    const invalidType = await call('PUT', '/admin/settings/backdating_days', {
      body: { value: 'six', version: 2 },
    });
    expect(invalidType.statusCode).toBe(400);
    const missingVersion = await call('PUT', '/admin/settings/backdating_days', {
      body: { value: 6 },
    });
    expect(missingVersion.statusCode).toBe(400);
    expect((await call('GET', '/admin/settings/nope')).statusCode).toBe(400);
    expect(
      (await call('PUT', '/admin/settings/nope', { body: { value: 1, version: 0 } })).statusCode,
    ).toBe(400);
  });

  it('rejects a malformed Idempotency-Key header', async () => {
    const withCaller = await call('PUT', '/admin/settings/backdating_days', {
      body: { value: 6, version: 2 },
      headers: { 'idempotency-key': '' },
    });
    expect(withCaller.statusCode).toBe(400);
  });
});

describe('number series admin', () => {
  const body = {
    code: 'route_test',
    prefix: 'RTE',
    padding: 4,
    resetYearly: true,
    gapless: false,
    startValue: 10,
  };

  it('creates (201), replays, lists, updates (200), conflicts (409) and validates (400)', async () => {
    const headers = { 'idempotency-key': 'series-1' };
    const created = await call('POST', '/admin/number-series', { body, headers });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ code: 'route_test', nextValue: 10, version: 1 });
    const replay = await call('POST', '/admin/number-series', { body, headers });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(created.json());

    const list = await call('GET', '/admin/number-series');
    const codes = list.json<{ items: { code: string }[] }>().items.map((s) => s.code);
    expect(codes).toEqual(expect.arrayContaining(['invoice', 'route_test']));

    const updated = await call('POST', '/admin/number-series', {
      body: { ...body, prefix: 'RT2', nextValue: 20, version: 1 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ prefix: 'RT2', nextValue: 20, version: 2 });

    const stale = await call('POST', '/admin/number-series', { body: { ...body, version: 1 } });
    expect(stale.statusCode).toBe(409);
    const duplicate = await call('POST', '/admin/number-series', { body });
    expect(duplicate.statusCode).toBe(409);
    const missing = await call('POST', '/admin/number-series', {
      body: { ...body, code: 'ghost', version: 1 },
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await call('POST', '/admin/number-series', { body: { ...body, padding: 0 } });
    expect(invalid.statusCode).toBe(400);
    const badCode = await call('POST', '/admin/number-series', {
      body: { ...body, code: 'Bad Code' },
    });
    expect(badCode.statusCode).toBe(400);
  });
});
