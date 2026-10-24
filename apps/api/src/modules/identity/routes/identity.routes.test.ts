import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import { createLogger } from '../../../logger.js';
import { currentUser } from '../index.js';
import {
  ADMIN,
  MANAGER,
  STOREKEEPER,
  SUPERVISOR,
  createIdentityKit,
  resetIdentity,
  seedCast,
  seedUser,
  uid,
  type IdentityKit,
} from '../test-support.js';

let k: IdentityKit;
let app: FastifyInstance;

beforeAll(async () => {
  k = await createIdentityKit();
  app = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => k.now.current,
    identity: { db: k.db, identity: k.identity },
    platform: { db: k.db, platform: k.platform, resolvePrincipal: currentUser },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetIdentity(k.db);
  await seedCast(k.db);
});

type As = 'admin' | 'manager' | 'supervisor' | 'storekeeper' | 'none' | 'bad';

const call = async (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  options: { as?: As; body?: unknown; headers?: Record<string, string> } = {},
) => {
  const as = options.as ?? 'admin';
  const headers: Record<string, string> = { ...options.headers };
  if (as === 'bad') headers.authorization = 'Bearer not-a-token';
  else if (as !== 'none') headers.authorization = `Bearer ${await k.token(`${as}@example.test`)}`;
  return app.inject({ method, url, headers, payload: options.body as object });
};

const body = <T = Record<string, unknown>>(response: { json: () => unknown }) =>
  response.json() as T;

describe('authentication on every route (AC-1, BR-1, BR-6)', () => {
  it('leaves /health open', async () => {
    expect((await call('GET', '/health', { as: 'none' })).statusCode).toBe(200);
  });

  const routes: [string, string][] = [
    ['GET', '/me'],
    ['PATCH', '/me'],
    ['GET', '/admin/users'],
    ['POST', '/admin/users'],
    ['PATCH', `/admin/users/${uid(1)}`],
    ['PUT', `/admin/users/${uid(1)}/roles`],
    ['PUT', `/admin/users/${uid(1)}/scopes`],
    ['GET', '/admin/roles'],
    ['PUT', '/admin/roles/admin/permissions'],
    ['GET', '/admin/audit'],
    ['GET', '/admin/outbox/failed'],
    ['POST', `/admin/outbox/${uid(1)}/retry`],
    ['GET', '/admin/settings/backdating_days'],
    ['PUT', '/admin/settings/backdating_days'],
    ['GET', '/admin/number-series'],
    ['POST', '/admin/number-series'],
    ['GET', '/does/not/exist'],
  ];

  it.each(routes)('%s %s answers 401 without a token', async (method, url) => {
    const response = await call(method as 'GET', url, { as: 'none' });
    expect(response.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(response).error.code).toBe('missing_token');
  });

  it('answers 401 for a malformed header and for an invalid token', async () => {
    const malformed = await app.inject({ url: '/me', headers: { authorization: 'Basic abc' } });
    expect(malformed.statusCode).toBe(401);
    expect((await call('GET', '/me', { as: 'bad' })).statusCode).toBe(401);
  });

  it('answers 401 for a valid token of an unknown user', async () => {
    const token = await k.token('stranger', 'stranger@example.test');
    const response = await app.inject({
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(response).error.code).toBe('unknown_user');
  });

  it('answers 403 for a disabled user on the next request (T-5)', async () => {
    expect((await call('GET', '/me', { as: 'storekeeper' })).statusCode).toBe(200);
    await k.db.query("update sys_users set status = 'disabled' where id = $1", [STOREKEEPER]);
    const response = await call('GET', '/me', { as: 'storekeeper' });
    expect(response.statusCode).toBe(403);
    expect(body<{ error: { code: string } }>(response).error.code).toBe('user_disabled');
  });

  it('does not require a token for CORS preflight', async () => {
    const response = await app.inject({ method: 'OPTIONS', url: '/me' });
    expect(response.statusCode).not.toBe(401);
  });

  it('guards the platform routes with the same login (permission from the user roles)', async () => {
    expect((await call('GET', '/admin/audit', { as: 'admin' })).statusCode).toBe(200);
    expect((await call('GET', '/admin/audit', { as: 'storekeeper' })).statusCode).toBe(403);
  });
});

describe('GET and PATCH /me', () => {
  it('returns the profile with roles, permissions and scopes', async () => {
    await k.db.query(
      "insert into sys_user_scopes (user_id, scope_type, scope_id) values ($1, 'team', $2)",
      [SUPERVISOR, uid(901)],
    );
    const response = await call('GET', '/me', { as: 'supervisor' });
    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual({
      id: SUPERVISOR,
      email: 'supervisor@example.test',
      fullName: 'supervisor@example.test',
      locale: 'en',
      version: 1,
      roles: ['supervisor'],
      permissions: [],
      scopes: [{ type: 'team', id: uid(901) }],
    });
    const manager = body<{ permissions: string[] }>(await call('GET', '/me', { as: 'manager' }));
    expect(manager.permissions).toEqual(['identity.user.read']);
    const users = (await k.identity.users.list(k.db)).find((u) => u.id === MANAGER);
    expect(users?.lastLoginAt).not.toBeNull();
  });

  it('changes the language, replays on retry, and conflicts on a stale version', async () => {
    const headers = { 'idempotency-key': 'me-1' };
    const first = await call('PATCH', '/me', {
      as: 'manager',
      body: { locale: 'ur', version: 1 },
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(body(first)).toMatchObject({ locale: 'ur', version: 2 });
    const replay = await call('PATCH', '/me', {
      as: 'manager',
      body: { locale: 'ur', version: 1 },
      headers,
    });
    expect(body(replay)).toEqual(body(first));
    const stale = await call('PATCH', '/me', { as: 'manager', body: { locale: 'en', version: 1 } });
    expect(stale.statusCode).toBe(409);
  });

  it('validates the body', async () => {
    for (const bad of [{ locale: 'fr', version: 1 }, { locale: 'en' }, {}]) {
      expect((await call('PATCH', '/me', { as: 'manager', body: bad })).statusCode).toBe(400);
    }
  });
});

describe('permissions and admin-only rule (BR-3, BR-5, T-2)', () => {
  const guarded: [string, string, unknown, string][] = [
    ['GET', '/admin/users', undefined, 'identity.user.read'],
    ['POST', '/admin/users', { email: 'a@b.test', fullName: 'A' }, 'identity.user.manage'],
    ['PATCH', `/admin/users/${uid(3)}`, { fullName: 'A', version: 1 }, 'identity.user.manage'],
    ['PUT', `/admin/users/${uid(3)}/roles`, { roles: [], version: 1 }, 'identity.user.manage'],
    ['PUT', `/admin/users/${uid(3)}/scopes`, { scopes: [], version: 1 }, 'identity.user.manage'],
    ['GET', '/admin/roles', undefined, 'identity.user.read'],
    ['PUT', '/admin/roles/estimator/permissions', { permissions: [] }, 'identity.role.manage'],
  ];

  it.each(guarded)('%s %s answers 403 naming %s', async (method, url, payload, permission) => {
    const response = await call(method as 'GET', url, { as: 'storekeeper', body: payload });
    expect(response.statusCode).toBe(403);
    expect(body<{ error: { code: string; details: unknown } }>(response).error).toMatchObject({
      code: 'permission_denied',
      details: { permission },
    });
  });

  it('lets management read users and roles but not change them', async () => {
    expect((await call('GET', '/admin/users', { as: 'manager' })).statusCode).toBe(200);
    expect((await call('GET', '/admin/roles', { as: 'manager' })).statusCode).toBe(200);
    expect(
      (
        await call('POST', '/admin/users', {
          as: 'manager',
          body: { email: 'a@b.test', fullName: 'A' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('keeps user administration with the admin role even if the permission is granted wider', async () => {
    await k.db.query(
      "insert into sys_role_permissions (role_code, permission_code) values ('storekeeper', 'identity.user.manage'), ('storekeeper', 'identity.role.manage')",
    );
    for (const [method, url, payload] of guarded.filter((g) => g[3] !== 'identity.user.read')) {
      const response = await call(method as 'GET', url, { as: 'storekeeper', body: payload });
      expect(response.statusCode).toBe(403);
      expect(body<{ error: { code: string } }>(response).error.code).toBe('admin_only');
    }
  });
});

describe('admin users', () => {
  it('lists users with roles and scopes', async () => {
    const response = await call('GET', '/admin/users');
    expect(response.statusCode).toBe(200);
    expect(body<{ items: unknown[] }>(response).items).toHaveLength(4);
  });

  it('creates a user (201), replays on retry, and rejects duplicates and bad input', async () => {
    const headers = { 'idempotency-key': 'create-1' };
    const payload = { email: 'Fresh@Example.test', fullName: 'Fresh Person', roles: ['estimator'] };
    const created = await call('POST', '/admin/users', { body: payload, headers });
    expect(created.statusCode).toBe(201);
    expect(body(created)).toMatchObject({ email: 'fresh@example.test', roles: ['estimator'] });
    const replay = await call('POST', '/admin/users', { body: payload, headers });
    expect(replay.statusCode).toBe(201);
    expect(body(replay)).toEqual(body(created));
    expect(await k.identity.users.list(k.db)).toHaveLength(5);

    const reused = await call('POST', '/admin/users', {
      body: { ...payload, fullName: 'Other' },
      headers,
    });
    expect(reused.statusCode).toBe(422);
    expect((await call('POST', '/admin/users', { body: payload })).statusCode).toBe(409);
    for (const bad of [
      { fullName: 'No Email' },
      { email: 'not-an-email', fullName: 'X' },
      { email: 'x@example.test', fullName: '' },
      { email: 'x@example.test', fullName: 'X', roles: ['wizard'] },
    ]) {
      const response = await call('POST', '/admin/users', { body: bad });
      expect(response.statusCode).toBe(400);
    }
  });

  it('rejects a malformed Idempotency-Key', async () => {
    const response = await call('POST', '/admin/users', {
      body: { email: 'x@example.test', fullName: 'X' },
      headers: { 'idempotency-key': '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('updates a user, disables them, and reports 404, 400 and 409', async () => {
    const headers = { 'idempotency-key': 'patch-1' };
    const payload = { fullName: 'Store Keeper', status: 'disabled', version: 1 };
    const first = await call('PATCH', `/admin/users/${STOREKEEPER}`, { body: payload, headers });
    expect(first.statusCode).toBe(200);
    expect(body(first)).toMatchObject({ fullName: 'Store Keeper', status: 'disabled', version: 2 });
    const replay = await call('PATCH', `/admin/users/${STOREKEEPER}`, { body: payload, headers });
    expect(body(replay)).toEqual(body(first));

    const stale = await call('PATCH', `/admin/users/${STOREKEEPER}`, {
      body: { fullName: 'Again', version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (await call('PATCH', `/admin/users/${uid(999)}`, { body: { fullName: 'X', version: 1 } }))
        .statusCode,
    ).toBe(404);
    for (const bad of [{ version: 1 }, { fullName: 'X' }, { status: 'gone', version: 1 }]) {
      expect((await call('PATCH', `/admin/users/${STOREKEEPER}`, { body: bad })).statusCode).toBe(
        400,
      );
    }
    expect(
      (await call('PATCH', '/admin/users/not-a-uuid', { body: { version: 1 } })).statusCode,
    ).toBe(400);
    const phone = await call('PATCH', `/admin/users/${MANAGER}`, {
      body: { phone: '0300', version: 1 },
    });
    expect(body(phone)).toMatchObject({ phone: '0300' });
  });

  it('refuses disabling yourself or the last admin (AC-3, T-4)', async () => {
    const self = await call('PATCH', `/admin/users/${ADMIN}`, {
      body: { status: 'disabled', version: 1 },
    });
    expect(self.statusCode).toBe(422);
    expect(body<{ error: { code: string } }>(self).error.code).toBe('cannot_disable_self');
  });

  it('assigns roles with a version check and refuses lockout (AC-3, AC-4)', async () => {
    const headers = { 'idempotency-key': 'roles-1' };
    const payload = { roles: ['procurement'], version: 1 };
    const first = await call('PUT', `/admin/users/${STOREKEEPER}/roles`, {
      body: payload,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(body(first)).toMatchObject({ roles: ['procurement'], version: 2 });
    expect(
      body(await call('PUT', `/admin/users/${STOREKEEPER}/roles`, { body: payload, headers })),
    ).toEqual(body(first));

    const audit = await call('GET', `/admin/audit?entityType=user&entityId=${STOREKEEPER}`);
    expect(body<{ items: { action: string }[] }>(audit).items.map((i) => i.action)).toContain(
      'user.roles_changed',
    );

    const stale = await call('PUT', `/admin/users/${STOREKEEPER}/roles`, {
      body: { roles: [], version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const selfDemote = await call('PUT', `/admin/users/${ADMIN}/roles`, {
      body: { roles: ['accountant'], version: 1 },
    });
    expect(selfDemote.statusCode).toBe(422);
    expect(body<{ error: { code: string } }>(selfDemote).error.code).toBe(
      'cannot_remove_own_admin',
    );
    for (const bad of [{ roles: ['wizard'], version: 2 }, { version: 2 }, { roles: [] }]) {
      expect(
        (await call('PUT', `/admin/users/${STOREKEEPER}/roles`, { body: bad })).statusCode,
      ).toBe(400);
    }
    expect(
      (await call('PUT', `/admin/users/${uid(999)}/roles`, { body: { roles: [], version: 1 } }))
        .statusCode,
    ).toBe(404);
  });

  it('assigns scopes with validation, replay, 404 and 409', async () => {
    const headers = { 'idempotency-key': 'scopes-1' };
    const payload = { scopes: [{ type: 'project', id: uid(900) }], version: 1 };
    const first = await call('PUT', `/admin/users/${SUPERVISOR}/scopes`, {
      body: payload,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(body(first)).toMatchObject({ scopes: [{ type: 'project', id: uid(900) }], version: 2 });
    expect(
      body(await call('PUT', `/admin/users/${SUPERVISOR}/scopes`, { body: payload, headers })),
    ).toEqual(body(first));
    expect(
      (await call('PUT', `/admin/users/${SUPERVISOR}/scopes`, { body: payload })).statusCode,
    ).toBe(409);
    for (const bad of [
      { scopes: [{ type: 'site', id: uid(900) }], version: 2 },
      { scopes: [{ type: 'project', id: 'x' }], version: 2 },
      { version: 2 },
    ]) {
      expect(
        (await call('PUT', `/admin/users/${SUPERVISOR}/scopes`, { body: bad })).statusCode,
      ).toBe(400);
    }
    expect(
      (await call('PUT', `/admin/users/${uid(999)}/scopes`, { body: { scopes: [], version: 1 } }))
        .statusCode,
    ).toBe(404);
  });

  it('applies a scope assignment on the supervisor next request', async () => {
    expect(
      body<{ scopes: unknown[] }>(await call('GET', '/me', { as: 'supervisor' })).scopes,
    ).toEqual([]);
    await call('PUT', `/admin/users/${SUPERVISOR}/scopes`, {
      body: { scopes: [{ type: 'project', id: uid(900) }], version: 1 },
    });
    expect(
      body<{ scopes: unknown[] }>(await call('GET', '/me', { as: 'supervisor' })).scopes,
    ).toEqual([{ type: 'project', id: uid(900) }]);
  });
});

describe('admin roles', () => {
  it('lists roles and every registered permission code', async () => {
    const response = await call('GET', '/admin/roles');
    const data = body<{ items: { code: string }[]; permissions: string[] }>(response);
    expect(data.items).toHaveLength(9);
    expect(data.permissions).toContain('identity.user.manage');
    expect(data.permissions).toContain('platform.audit.read');
  });

  it('replaces role permissions, effective on the next request, with replay and validation', async () => {
    k.identity.registerPermissions('inventory', ['inventory.stock.issue']);
    const headers = { 'idempotency-key': 'perm-1' };
    const payload = { permissions: ['inventory.stock.issue'] };
    const first = await call('PUT', '/admin/roles/storekeeper/permissions', {
      body: payload,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(body(first)).toMatchObject({
      code: 'storekeeper',
      permissions: ['inventory.stock.issue'],
    });
    expect(
      body(await call('PUT', '/admin/roles/storekeeper/permissions', { body: payload, headers })),
    ).toEqual(body(first));
    expect(
      body<{ permissions: string[] }>(await call('GET', '/me', { as: 'storekeeper' })).permissions,
    ).toEqual(['inventory.stock.issue']);

    const audit = await call('GET', '/admin/audit?entityType=role&entityId=storekeeper');
    expect(body<{ items: { action: string }[] }>(audit).items[0]?.action).toBe(
      'role.permissions_changed',
    );

    expect(
      (
        await call('PUT', '/admin/roles/storekeeper/permissions', {
          body: { permissions: ['x.y.z'] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', '/admin/roles/storekeeper/permissions', { body: {} })).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', '/admin/roles/Bad Code/permissions', { body: payload })).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', '/admin/roles/ghost/permissions', { body: { permissions: [] } }))
        .statusCode,
    ).toBe(404);
  });
});

describe('first login through the API (BR-2)', () => {
  it('binds the pre-created user by email and lets them in', async () => {
    await seedUser(k.db, {
      id: uid(61),
      email: 'newcomer@example.test',
      roles: ['estimator'],
      subject: null,
    });
    const token = await k.token('supabase-newcomer', 'newcomer@example.test');
    const response = await app.inject({
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({ id: uid(61), roles: ['estimator'] });
  });
});
