import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPermissionRegistry } from './permission-registry.service.js';
import { ADMIN, createIdentityKit, resetIdentity, type IdentityKit } from '../test-support.js';

let k: IdentityKit;
const ctx = { actorUserId: ADMIN, requestId: 'req-2' };

beforeAll(async () => {
  k = await createIdentityKit();
  k.identity.registerPermissions('inventory', ['inventory.stock.issue', 'inventory.stock.read']);
}, 60_000);

beforeEach(async () => {
  await resetIdentity(k.db);
});

describe('permission registry', () => {
  it('registers well-formed codes of the module and lists them sorted', () => {
    const registry = createPermissionRegistry();
    registry.register('a', ['a.x.write', 'a.x.read']);
    registry.register('a', ['a.x.read']);
    expect(registry.list()).toEqual(['a.x.read', 'a.x.write']);
    expect(registry.has('a.x.read')).toBe(true);
    expect(registry.has('b.x.read')).toBe(false);
  });

  it('rejects codes of another module or with the wrong shape', () => {
    const registry = createPermissionRegistry();
    expect(() => registry.register('a', ['b.x.read'])).toThrow(
      expect.objectContaining({ code: 'invalid_permission_code' }),
    );
    expect(() => registry.register('a', ['a.read'])).toThrow(
      expect.objectContaining({ code: 'invalid_permission_code' }),
    );
    expect(createPermissionRegistry().list()).toEqual([]);
  });
});

describe('roles', () => {
  it('lists the seeded roles with their permissions (BR-8)', async () => {
    const roles = await k.identity.roles.list(k.db);
    expect(roles.map((r) => r.code)).toEqual([
      'accountant',
      'admin',
      'estimator',
      'management',
      'procurement',
      'project_manager',
      'service_coordinator',
      'storekeeper',
      'supervisor',
    ]);
    expect(roles.find((r) => r.code === 'management')).toMatchObject({
      system: true,
      permissions: ['identity.user.read'],
    });
    expect(roles.find((r) => r.code === 'estimator')?.permissions).toEqual([]);
  });

  it('replaces the permissions of a role and audits before and after (AC-4)', async () => {
    const updated = await k.db.transaction((tx) =>
      k.identity.roles.setPermissions(
        'storekeeper',
        ['inventory.stock.read', 'inventory.stock.issue', 'inventory.stock.read'],
        ctx,
        tx,
      ),
    );
    expect(updated.permissions).toEqual(['inventory.stock.issue', 'inventory.stock.read']);
    const [entry] = await k.platform.audit.search(k.db, {
      entityType: 'role',
      entityId: 'storekeeper',
      limit: 1,
      offset: 0,
    });
    expect(entry).toMatchObject({
      action: 'role.permissions_changed',
      before: { permissions: [] },
      after: { permissions: ['inventory.stock.issue', 'inventory.stock.read'] },
      actor_user_id: ADMIN,
    });
    expect(
      await k.db.query(
        "select id from sys_outbox where type = 'identity.role.permissions_changed'",
      ),
    ).toHaveLength(1);

    const cleared = await k.db.transaction((tx) =>
      k.identity.roles.setPermissions('storekeeper', [], ctx, tx),
    );
    expect(cleared.permissions).toEqual([]);
  });

  it('rejects unknown, malformed and unregistered permission codes', async () => {
    for (const bad of ['inventory.stock.destroy', 'nonsense']) {
      await expect(
        k.db.transaction((tx) => k.identity.roles.setPermissions('storekeeper', [bad], ctx, tx)),
      ).rejects.toMatchObject({ kind: 'validation', code: 'unknown_permission' });
    }
  });

  it('answers 404 for an unknown role', async () => {
    await expect(
      k.db.transaction((tx) => k.identity.roles.setPermissions('ghost', [], ctx, tx)),
    ).rejects.toMatchObject({ kind: 'not_found', code: 'role_not_found' });
  });

  it('registers a role once and leaves an existing one untouched', async () => {
    expect(await k.identity.registerRole('worker', 'Worker', 'Sees own records', k.db)).toBe(true);
    expect(await k.identity.registerRole('worker', 'Other name', 'Other', k.db)).toBe(false);
    const worker = (await k.identity.roles.list(k.db)).find((r) => r.code === 'worker');
    expect(worker).toMatchObject({ name: 'Worker', system: false });
  });
});
