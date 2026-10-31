import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listRoutes } from '../../../acceptance/routes.js';
import {
  ACCOUNTANT,
  ADMIN,
  FRIDAY,
  LOGIN_A,
  LOGIN_B,
  LOGIN_MIXED,
  LOGIN_SPARE,
  NOBODY,
  THURSDAY,
  auditCount,
  createPortalKit,
  type PortalKit,
} from '../test-support.js';

vi.setConfig({ testTimeout: 120_000 });

let kit: PortalKit;
beforeAll(async () => {
  kit = await createPortalKit();
  await kit.approveAttendance(FRIDAY);
  await kit.approveAttendance(THURSDAY);
  await kit.link(kit.workerA.id, LOGIN_A);
  await kit.link(kit.workerB.id, LOGIN_B);
}, 120_000);
afterAll(() => kit.close());

interface Call {
  method: 'GET' | 'PUT' | 'DELETE';
  url: string;
  user?: string | undefined;
  body?: unknown;
  key?: string | undefined;
  headers?: Record<string, string>;
}

const call = async ({ method, url, user = LOGIN_A, body, key, headers = {} }: Call) => {
  const response = await kit.app.inject({
    method,
    url,
    headers: {
      ...(await kit.auth(user)),
      ...headers,
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
const MISSING = '018f0000-0000-7000-8000-000000000999';
const OWN_ROUTES = [
  '/me/worker/attendance?month=2026-10',
  '/me/worker/advances',
  '/me/worker/wages?month=2026-10',
];

describe('authentication and permissions', () => {
  it('refuses anonymous callers on every route', async () => {
    for (const [method, url] of [
      ...OWN_ROUTES.map((route) => ['GET', route]),
      ['GET', `/admin/workers/${MISSING}/account`],
      ['PUT', `/admin/workers/${MISSING}/account`],
      ['DELETE', `/admin/workers/${MISSING}/account`],
    ] as const) {
      expect((await kit.app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('keeps /me/worker for the worker role and the account endpoints for the admin', async () => {
    for (const user of [ACCOUNTANT, ADMIN, NOBODY]) {
      for (const url of OWN_ROUTES) {
        expect((await call({ method: 'GET', url, user })).status, `${user} ${url}`).toBe(403);
      }
    }
    for (const user of [LOGIN_A, ACCOUNTANT, NOBODY]) {
      const base = { user, url: `/admin/workers/${kit.workerA.id}/account` };
      expect((await call({ ...base, method: 'GET' })).status).toBe(403);
      expect((await call({ ...base, method: 'PUT', body: { userId: LOGIN_SPARE } })).status).toBe(
        403,
      );
      expect((await call({ ...base, method: 'DELETE' })).status).toBe(403);
    }
  });

  it('answers 403 to a worker login that is not linked', async () => {
    for (const url of OWN_ROUTES) {
      const result = await call({ method: 'GET', url, user: LOGIN_SPARE });
      expect(result.status, url).toBe(403);
      expect(errorCode(result)).toBe('no_worker_link');
    }
  });
});

describe('a worker sees only their own records (T-1, AC-1, AC-2)', () => {
  it('returns the same own data whatever ids, query strings or headers are sent', async () => {
    const own = await call({ method: 'GET', url: OWN_ROUTES[0] as string });
    expect(own.status).toBe(200);
    const days = (own.body as { days: { overtimeHours: string }[] }).days;
    expect(days.map((day) => day.overtimeHours)).toEqual(['2.00', '2.00']);

    const other = await call({ method: 'GET', url: OWN_ROUTES[0] as string, user: LOGIN_B });
    expect(
      (other.body as { days: { overtimeHours: string }[] }).days.map((d) => d.overtimeHours),
    ).toEqual(['0.00', '0.00']);

    const bId = kit.workerB.id;
    const attempts: Omit<Call, 'user'>[] = [];
    for (const url of OWN_ROUTES) {
      const sep = url.includes('?') ? '&' : '?';
      attempts.push(
        { method: 'GET', url },
        { method: 'GET', url: `${url}${sep}workerId=${bId}` },
        { method: 'GET', url: `${url}${sep}worker_id=${bId}&userId=${LOGIN_B}` },
        { method: 'GET', url, headers: { 'x-worker-id': bId, 'x-user-id': LOGIN_B } },
      );
    }
    for (const attempt of attempts) {
      const bare = attempt.url.split(/[?&]/)[0] as string;
      const result = await call({ ...attempt, user: LOGIN_A });
      const reference = await call({
        method: 'GET',
        url: OWN_ROUTES.find((u) => u.startsWith(bare)) as string,
      });
      expect(result, `${attempt.url} ${JSON.stringify(attempt.headers ?? {})}`).toEqual(reference);
    }
  });

  it('has no route that takes a worker id under /me/worker', () => {
    const mine = listRoutes(kit.app)
      .filter((route) => route.pattern.startsWith('/me/worker'))
      .map((route) => `${route.method} ${route.pattern}`);
    expect(mine).toEqual([
      'GET /me/worker/advances',
      'GET /me/worker/attendance',
      'GET /me/worker/wages',
    ]);
  });

  it('validates the month', async () => {
    for (const url of ['/me/worker/attendance', '/me/worker/wages?month=2026-13']) {
      expect((await call({ method: 'GET', url })).status, url).toBe(400);
    }
  });

  it('serves a login that holds the worker role and another role (BR-1 confirmed)', async () => {
    await kit.link(kit.workerB.id, LOGIN_MIXED, true);
    const result = await call({ method: 'GET', url: '/me/worker/advances', user: LOGIN_MIXED });
    expect(result.status).toBe(200);
    await kit.link(kit.workerB.id, LOGIN_B);
  });

  it('lets a worker log in and see their own attendance only (T-5 end to end)', async () => {
    const a = await call({ method: 'GET', url: '/me/worker/attendance?month=2026-10' });
    expect(a).toEqual({
      status: 200,
      body: {
        month: '2026-10',
        days: [
          { date: THURSDAY, status: 'present', overtimeHours: '2.00' },
          { date: FRIDAY, status: 'present', overtimeHours: '2.00' },
        ],
      },
    });
    const profile = await call({ method: 'GET', url: '/me', user: LOGIN_A });
    expect((profile.body as { permissions: string[] }).permissions).toEqual([
      'workerportal.self.read',
    ]);
  });
});

describe('linking endpoints (BR-1, AC-3)', () => {
  const url = () => `/admin/workers/${kit.workerA.id}/account`;

  it('shows the current login of a worker', async () => {
    expect(await call({ method: 'GET', url: url(), user: ADMIN })).toMatchObject({
      status: 200,
      body: { account: { userId: LOGIN_A, workerId: kit.workerA.id } },
    });
    expect(
      (await call({ method: 'GET', url: `/admin/workers/${MISSING}/account`, user: ADMIN })).status,
    ).toBe(404);
  });

  it('rejects a bad body and an unknown worker or user', async () => {
    expect(
      (await call({ method: 'PUT', url: url(), user: ADMIN, body: { userId: 'nope' } })).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'PUT',
          url: '/admin/workers/not-a-uuid/account',
          user: ADMIN,
          body: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call({
          method: 'PUT',
          url: `/admin/workers/${MISSING}/account`,
          user: ADMIN,
          body: { userId: LOGIN_SPARE },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call({ method: 'PUT', url: url(), user: ADMIN, body: { userId: MISSING } })).status,
    ).toBe(404);
    expect(
      (await call({ method: 'DELETE', url: `/admin/workers/${MISSING}/account`, user: ADMIN }))
        .status,
    ).toBe(404);
  });

  it('refuses a rejected Idempotency-Key header and replays a retry', async () => {
    const bad = await kit.app.inject({
      method: 'PUT',
      url: url(),
      headers: { ...(await kit.auth(ADMIN)), 'idempotency-key': '' },
      payload: { userId: LOGIN_SPARE },
    });
    expect(bad.statusCode).toBe(400);

    const before = await auditCount(kit.db, 'workerportal.account.link');
    const first = await call({
      method: 'PUT',
      url: url(),
      user: ADMIN,
      body: { userId: LOGIN_SPARE },
      key: 'link-1',
    });
    const retry = await call({
      method: 'PUT',
      url: url(),
      user: ADMIN,
      body: { userId: LOGIN_SPARE },
      key: 'link-1',
    });
    expect(first.status).toBe(200);
    expect(retry).toEqual(first);
    expect(await auditCount(kit.db, 'workerportal.account.link')).toBe(before + 1);
  });

  it('answers 400 for a login with other roles unless confirmed, then links', async () => {
    const unconfirmed = await call({
      method: 'PUT',
      url: url(),
      user: ADMIN,
      body: { userId: LOGIN_MIXED },
    });
    expect(unconfirmed.status).toBe(400);
    expect(errorCode(unconfirmed)).toBe('user_has_other_roles');
    const confirmed = await call({
      method: 'PUT',
      url: url(),
      user: ADMIN,
      body: { userId: LOGIN_MIXED, confirmOtherRoles: true },
    });
    expect(confirmed.status).toBe(200);
  });

  it('unlinks, audits it, and the login then has no access', async () => {
    const result = await call({ method: 'DELETE', url: url(), user: ADMIN, key: 'unlink-1' });
    expect(result.status).toBe(204);
    expect(await auditCount(kit.db, 'workerportal.account.unlink')).toBe(1);
    expect((await call({ method: 'DELETE', url: url(), user: ADMIN })).status).toBe(404);
    const gone = await call({ method: 'GET', url: OWN_ROUTES[1] as string, user: LOGIN_MIXED });
    expect(gone.status).toBe(403);
  });
});
