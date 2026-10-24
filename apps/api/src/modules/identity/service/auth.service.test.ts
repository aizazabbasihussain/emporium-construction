import type { SqlDb } from '@emporium/db';
import { identityPermissions, platformPermissions } from '@emporium/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  MANAGER,
  STOREKEEPER,
  createIdentityKit,
  resetIdentity,
  seedCast,
  seedUser,
  uid,
  type IdentityKit,
} from '../test-support.js';

let k: IdentityKit;

beforeAll(async () => {
  k = await createIdentityKit();
}, 60_000);

beforeEach(async () => {
  await resetIdentity(k.db);
  await seedCast(k.db);
});

const auth = (subject: string, email?: string | null) =>
  k.token(subject, email).then((token) => k.identity.auth.authenticate(k.db, token));

describe('authenticate (BR-1, BR-3, BR-6, T-2, T-5)', () => {
  it('maps a valid token to the active user with the union of their role permissions', async () => {
    const admin = await auth('admin@example.test');
    expect(admin).toMatchObject({
      userId: ADMIN,
      email: 'admin@example.test',
      roles: ['admin'],
      locale: 'en',
    });
    expect(admin.permissions.has(identityPermissions.userManage)).toBe(true);
    expect(admin.permissions.has(platformPermissions.backdateOverride)).toBe(true);
  });

  it('unions the permissions of several roles', async () => {
    await k.db.query("insert into sys_user_roles (user_id, role_code) values ($1, 'accountant')", [
      MANAGER,
    ]);
    const manager = await auth('manager@example.test');
    expect(manager.roles).toEqual(['accountant', 'management']);
    expect(manager.permissions).toEqual(
      new Set([
        identityPermissions.userRead,
        platformPermissions.auditRead,
        platformPermissions.seriesManage,
      ]),
    );
  });

  it('gives a user without roles no permissions', async () => {
    await seedUser(k.db, { id: uid(50), email: 'none@example.test', roles: [] });
    const none = await auth('none@example.test');
    expect(none.roles).toEqual([]);
    expect(none.permissions.size).toBe(0);
  });

  it('rejects an unknown subject whose email matches nobody with 401', async () => {
    await expect(auth('stranger', 'stranger@example.test')).rejects.toMatchObject({
      kind: 'unauthorized',
      code: 'unknown_user',
    });
    await expect(auth('stranger', null)).rejects.toMatchObject({ code: 'unknown_user' });
  });

  it('rejects an invalid token with 401', async () => {
    await expect(k.identity.auth.authenticate(k.db, 'garbage')).rejects.toMatchObject({
      kind: 'unauthorized',
      code: 'invalid_token',
    });
  });

  it('rejects a disabled user with 403, and does so on the very next request (T-5)', async () => {
    await auth('storekeeper@example.test');
    await k.db.query("update sys_users set status = 'disabled' where id = $1", [STOREKEEPER]);
    await expect(auth('storekeeper@example.test')).rejects.toMatchObject({
      kind: 'forbidden',
      code: 'user_disabled',
    });
  });

  it('applies a role-permission edit on the next request (BR-7)', async () => {
    const before = await auth('storekeeper@example.test');
    expect(before.permissions.size).toBe(0);
    await k.db.query(
      "insert into sys_role_permissions (role_code, permission_code) values ('storekeeper', 'inventory.stock.issue')",
    );
    expect((await auth('storekeeper@example.test')).permissions.has('inventory.stock.issue')).toBe(
      true,
    );
  });

  it('loads scopes for the user', async () => {
    await k.db.query(
      "insert into sys_user_scopes (user_id, scope_type, scope_id) values ($1, 'project', $2)",
      [uid(3), uid(900)],
    );
    expect((await auth('supervisor@example.test')).scopes).toEqual([
      { type: 'project', id: uid(900) },
    ]);
  });
});

describe('first login binds the subject (BR-2)', () => {
  const preCreate = (email: string) =>
    k.db.query("insert into sys_users (id, email, full_name) values ($1, $2, 'New Person')", [
      uid(60),
      email,
    ]);

  it('binds by the verified email, audits it, and then finds the user by subject', async () => {
    await preCreate('new.person@example.test');
    const first = await auth('supabase-sub-1', 'New.Person@Example.test');
    expect(first.userId).toBe(uid(60));
    expect(first.version).toBe(2);

    const rows = await k.db.query<{ auth_subject: string; last_login_at: Date | null }>(
      'select auth_subject, last_login_at from sys_users where id = $1',
      [uid(60)],
    );
    expect(rows[0]?.auth_subject).toBe('supabase-sub-1');
    expect(rows[0]?.last_login_at).not.toBeNull();

    const audits = await k.platform.audit.search(k.db, {
      entityType: 'user',
      entityId: uid(60),
      limit: 10,
      offset: 0,
    });
    expect(audits.map((a) => a.action)).toEqual(['user.bind_subject']);
    expect(
      await k.db.query("select id from sys_outbox where type = 'identity.user.first_login'"),
    ).toHaveLength(1);

    // The email is no longer needed once the subject is bound.
    expect((await auth('supabase-sub-1', null)).userId).toBe(uid(60));
  });

  it('refuses a second subject claiming an already bound email', async () => {
    await preCreate('new.person@example.test');
    await auth('supabase-sub-1', 'new.person@example.test');
    await expect(auth('another-sub', 'new.person@example.test')).rejects.toMatchObject({
      code: 'unknown_user',
    });
  });

  it('refuses when the user was bound by a concurrent first login', async () => {
    await preCreate('new.person@example.test');
    await auth('supabase-sub-1', 'new.person@example.test');
    // A stale read still shows the row as unbound; the guarded update then matches nothing.
    const stale: SqlDb = {
      ...k.db,
      query: async (sql, params) => {
        const rows = await k.db.query<Record<string, unknown>>(sql, params);
        return (
          sql.includes('where email =') ? rows.map((row) => ({ ...row, auth_subject: null })) : rows
        ) as never;
      },
      transaction: (fn) => k.db.transaction(fn),
    };
    const token = await k.token('late-sub', 'new.person@example.test');
    await expect(k.identity.auth.authenticate(stale, token)).rejects.toMatchObject({
      code: 'unknown_user',
    });
  });

  it('does not bind a user who is soft deleted', async () => {
    await preCreate('gone@example.test');
    await k.db.query('update sys_users set deleted_at = now() where id = $1', [uid(60)]);
    await expect(auth('sub-x', 'gone@example.test')).rejects.toMatchObject({
      code: 'unknown_user',
    });
  });
});
