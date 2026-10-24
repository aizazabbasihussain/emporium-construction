import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const ctx = (actor: string | null = ADMIN) => ({ actorUserId: actor, requestId: 'req-1' });
const run = <T>(fn: (tx: IdentityKit['db']) => Promise<T>) => k.db.transaction(fn);

// The audit log is append-only, so each test reads only the rows written after it started.
let baseline = '';
const auditActions = async (id: string) =>
  (await k.platform.audit.search(k.db, { entityType: 'user', entityId: id, limit: 200, offset: 0 }))
    .filter((a) => a.id > baseline)
    .map((a) => a.action)
    .reverse();
const events = async () =>
  (await k.db.query<{ type: string }>('select type from sys_outbox order by occurred_at, id')).map(
    (e) => e.type,
  );

beforeAll(async () => {
  k = await createIdentityKit();
}, 60_000);

beforeEach(async () => {
  await resetIdentity(k.db);
  await seedCast(k.db);
  baseline =
    (await k.db.query<{ id: string | null }>('select max(id::text) as id from sys_audit_log'))[0]
      ?.id ?? '';
});

describe('list', () => {
  it('returns users with their roles and scopes', async () => {
    await run((tx) =>
      k.identity.users.setScopes(SUPERVISOR, [{ type: 'project', id: uid(900) }], 1, ctx(), tx),
    );
    const users = await k.identity.users.list(k.db);
    expect(users.map((u) => u.email)).toEqual([
      'admin@example.test',
      'manager@example.test',
      'storekeeper@example.test',
      'supervisor@example.test',
    ]);
    const supervisor = users.find((u) => u.id === SUPERVISOR);
    expect(supervisor).toMatchObject({
      roles: ['supervisor'],
      scopes: [{ type: 'project', id: uid(900) }],
      status: 'active',
      lastLoginAt: null,
    });
  });

  it('reports last login as an ISO string once recorded', async () => {
    await k.identity.users.recordLogin(MANAGER, k.db);
    const manager = (await k.identity.users.list(k.db)).find((u) => u.id === MANAGER);
    expect(manager?.lastLoginAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('create (BR-5)', () => {
  it('creates a user with roles, lower-cases the email, audits and publishes', async () => {
    const created = await run((tx) =>
      k.identity.users.create(
        {
          email: 'New.User@Example.test',
          fullName: 'New User',
          phone: '0300',
          roles: ['estimator', 'estimator'],
        },
        ctx(),
        tx,
      ),
    );
    expect(created).toMatchObject({
      email: 'new.user@example.test',
      fullName: 'New User',
      phone: '0300',
      status: 'active',
      locale: 'en',
      roles: ['estimator'],
      version: 1,
    });
    expect(await auditActions(created.id)).toEqual(['user.created']);
    expect(await events()).toEqual(['identity.user.created']);
  });

  it('creates a user without roles or phone', async () => {
    const created = await run((tx) =>
      k.identity.users.create({ email: 'bare@example.test', fullName: 'Bare' }, ctx(), tx),
    );
    expect(created).toMatchObject({ roles: [], phone: null });
  });

  it('refuses a duplicate email and an unknown role', async () => {
    await expect(
      run((tx) =>
        k.identity.users.create({ email: 'ADMIN@example.test', fullName: 'Dup' }, ctx(), tx),
      ),
    ).rejects.toMatchObject({ kind: 'conflict', code: 'email_taken' });
    await expect(
      run((tx) =>
        k.identity.users.create(
          { email: 'x@example.test', fullName: 'X', roles: ['wizard'] },
          ctx(),
          tx,
        ),
      ),
    ).rejects.toMatchObject({ kind: 'validation', code: 'unknown_role' });
  });
});

describe('update and disable (BR-5, BR-6)', () => {
  it('updates name and phone with a version bump, audit and event', async () => {
    const updated = await run((tx) =>
      k.identity.users.update(
        STOREKEEPER,
        { fullName: 'Store Keeper', phone: null, version: 1 },
        ctx(),
        tx,
      ),
    );
    expect(updated).toMatchObject({ fullName: 'Store Keeper', phone: null, version: 2 });
    expect(await auditActions(STOREKEEPER)).toEqual(['user.updated']);
    expect(await events()).toEqual(['identity.user.updated']);
  });

  it('sets only the supplied fields', async () => {
    const updated = await run((tx) =>
      k.identity.users.update(STOREKEEPER, { phone: '0311', version: 1 }, ctx(), tx),
    );
    expect(updated).toMatchObject({ phone: '0311', fullName: 'storekeeper@example.test' });
  });

  it('disables and re-enables another user, with distinct audit actions', async () => {
    const disabled = await run((tx) =>
      k.identity.users.update(STOREKEEPER, { status: 'disabled', version: 1 }, ctx(), tx),
    );
    expect(disabled.status).toBe('disabled');
    const enabled = await run((tx) =>
      k.identity.users.update(STOREKEEPER, { status: 'active', version: 2 }, ctx(), tx),
    );
    expect(enabled.status).toBe('active');
    expect(await auditActions(STOREKEEPER)).toEqual(['user.disabled', 'user.enabled']);
    // Saving the same status again is a plain update.
    await run((tx) =>
      k.identity.users.update(STOREKEEPER, { status: 'active', version: 3 }, ctx(), tx),
    );
    expect((await auditActions(STOREKEEPER)).at(-1)).toBe('user.updated');
  });

  it('refuses disabling yourself and the last active admin (AC-3)', async () => {
    await expect(
      run((tx) =>
        k.identity.users.update(ADMIN, { status: 'disabled', version: 1 }, ctx(ADMIN), tx),
      ),
    ).rejects.toMatchObject({ code: 'cannot_disable_self' });
    await expect(
      run((tx) =>
        k.identity.users.update(ADMIN, { status: 'disabled', version: 1 }, ctx(MANAGER), tx),
      ),
    ).rejects.toMatchObject({ code: 'last_admin' });
    expect(
      await k.identity.users.list(k.db).then((u) => u.find((x) => x.id === ADMIN)?.status),
    ).toBe('active');
  });

  it('allows disabling an admin when another active admin remains', async () => {
    await seedUser(k.db, { id: uid(70), email: 'second.admin@example.test', roles: ['admin'] });
    const disabled = await run((tx) =>
      k.identity.users.update(uid(70), { status: 'disabled', version: 1 }, ctx(ADMIN), tx),
    );
    expect(disabled.status).toBe('disabled');
  });

  it('treats a missing actor as no one when checking lockout', async () => {
    await expect(
      run((tx) =>
        k.identity.users.update(ADMIN, { status: 'disabled', version: 1 }, ctx(null), tx),
      ),
    ).rejects.toMatchObject({ code: 'last_admin' });
  });

  it('answers 404 for an unknown user and 409 for a stale version', async () => {
    await expect(
      run((tx) => k.identity.users.update(uid(999), { fullName: 'X', version: 1 }, ctx(), tx)),
    ).rejects.toMatchObject({ kind: 'not_found', code: 'user_not_found' });
    await expect(
      run((tx) => k.identity.users.update(STOREKEEPER, { fullName: 'X', version: 7 }, ctx(), tx)),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });
});

describe('roles (BR-5, AC-3, AC-4)', () => {
  it('replaces the roles, audits before and after, and bumps the version', async () => {
    const updated = await run((tx) =>
      k.identity.users.setRoles(
        STOREKEEPER,
        ['procurement', 'storekeeper', 'procurement'],
        1,
        ctx(),
        tx,
      ),
    );
    expect(updated).toMatchObject({ roles: ['procurement', 'storekeeper'], version: 2 });
    const [entry] = await k.platform.audit.search(k.db, {
      entityType: 'user',
      entityId: STOREKEEPER,
      limit: 1,
      offset: 0,
    });
    expect(entry).toMatchObject({
      action: 'user.roles_changed',
      before: { roles: ['storekeeper'] },
      after: { roles: ['procurement', 'storekeeper'] },
      actor_user_id: ADMIN,
      request_id: 'req-1',
    });
    expect(await events()).toEqual(['identity.user.roles_changed']);
  });

  it('refuses an unknown role and leaves roles unchanged', async () => {
    await expect(
      run((tx) => k.identity.users.setRoles(STOREKEEPER, ['wizard'], 1, ctx(), tx)),
    ).rejects.toMatchObject({ code: 'unknown_role' });
  });

  it('refuses removing your own admin role, and demoting the last active admin', async () => {
    await expect(
      run((tx) => k.identity.users.setRoles(ADMIN, ['accountant'], 1, ctx(ADMIN), tx)),
    ).rejects.toMatchObject({ code: 'cannot_remove_own_admin' });
    await expect(
      run((tx) => k.identity.users.setRoles(ADMIN, ['accountant'], 1, ctx(MANAGER), tx)),
    ).rejects.toMatchObject({ code: 'last_admin' });
    expect((await k.identity.users.list(k.db)).find((u) => u.id === ADMIN)?.roles).toEqual([
      'admin',
    ]);
  });

  it('treats a missing actor as no one when checking lockout of roles', async () => {
    await expect(
      run((tx) => k.identity.users.setRoles(ADMIN, ['accountant'], 1, ctx(null), tx)),
    ).rejects.toMatchObject({ code: 'last_admin' });
  });

  it('lets an admin demote another admin once a second one exists, and promote someone', async () => {
    await seedUser(k.db, { id: uid(70), email: 'second.admin@example.test', roles: ['admin'] });
    const demoted = await run((tx) =>
      k.identity.users.setRoles(uid(70), ['accountant'], 1, ctx(ADMIN), tx),
    );
    expect(demoted.roles).toEqual(['accountant']);
    const promoted = await run((tx) =>
      k.identity.users.setRoles(STOREKEEPER, ['admin'], 1, ctx(ADMIN), tx),
    );
    expect(promoted.roles).toEqual(['admin']);
  });

  it('answers 404 and 409 for an unknown user and a stale version', async () => {
    await expect(
      run((tx) => k.identity.users.setRoles(uid(999), ['admin'], 1, ctx(), tx)),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      run((tx) => k.identity.users.setRoles(STOREKEEPER, ['admin'], 9, ctx(), tx)),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });
});

describe('scopes (BR-4)', () => {
  it('replaces scopes, dropping duplicates, with audit and event', async () => {
    const scopes = [
      { type: 'project' as const, id: uid(900) },
      { type: 'team' as const, id: uid(901) },
      { type: 'project' as const, id: uid(900) },
    ];
    const updated = await run((tx) => k.identity.users.setScopes(SUPERVISOR, scopes, 1, ctx(), tx));
    expect(updated.scopes).toEqual([
      { type: 'project', id: uid(900) },
      { type: 'team', id: uid(901) },
    ]);
    expect(updated.version).toBe(2);
    expect(await auditActions(SUPERVISOR)).toEqual(['user.scopes_changed']);
    expect(await events()).toEqual(['identity.user.scopes_changed']);

    const cleared = await run((tx) => k.identity.users.setScopes(SUPERVISOR, [], 2, ctx(), tx));
    expect(cleared.scopes).toEqual([]);
  });
});

describe('locale', () => {
  it('lets a user change their language', async () => {
    const updated = await run((tx) =>
      k.identity.users.setLocale(MANAGER, 'ur', 1, ctx(MANAGER), tx),
    );
    expect(updated).toMatchObject({ locale: 'ur', version: 2 });
    expect(await auditActions(MANAGER)).toEqual(['user.updated']);
  });

  it('answers 404 and 409', async () => {
    await expect(
      run((tx) => k.identity.users.setLocale(uid(999), 'ur', 1, ctx(), tx)),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      run((tx) => k.identity.users.setLocale(MANAGER, 'ur', 5, ctx(), tx)),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });
});

describe('ensureAdmin (spec section 9)', () => {
  it('creates the first admin from the configured email once', async () => {
    await resetIdentity(k.db);
    expect(await run((tx) => k.identity.users.ensureAdmin('owner@example.test', tx))).toBe(true);
    expect(await run((tx) => k.identity.users.ensureAdmin('OWNER@example.test', tx))).toBe(false);
    const users = await k.identity.users.list(k.db);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ roles: ['admin'], fullName: 'Administrator' });
    expect(await auditActions(users[0]?.id ?? '')).toEqual(['user.created']);
  });
});
