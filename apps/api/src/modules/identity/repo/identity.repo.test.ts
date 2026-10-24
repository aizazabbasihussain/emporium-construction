import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createIdentityKit,
  resetIdentity,
  seedUser,
  uid,
  type IdentityKit,
} from '../test-support.js';
import {
  bindSubject,
  countActiveAdmins,
  existingRoleCodes,
  findRole,
  findUserByEmail,
  findUserById,
  findUserBySubject,
  insertRoleIfAbsent,
  insertUser,
  listRoles,
  listUsers,
  replaceRolePermissions,
  replaceUserRoles,
  replaceUserScopes,
  selectAllRolePermissions,
  selectAllScopes,
  selectAllUserRoles,
  selectRoleCodes,
  selectRolePermissions,
  selectScopes,
  touchLogin,
  updateUser,
} from './identity.repo.js';

let k: IdentityKit;

beforeAll(async () => {
  k = await createIdentityKit();
}, 60_000);

beforeEach(async () => {
  await resetIdentity(k.db);
});

const person = {
  id: uid(10),
  email: 'Mixed.Case@Example.test',
  fullName: 'P',
  phone: null,
  actor: null,
};

describe('users', () => {
  it('inserts, finds by id, email (case-insensitive) and subject, and lists', async () => {
    const row = await insertUser(k.db, person);
    expect(row).toMatchObject({ email: 'mixed.case@example.test', status: 'active', version: 1 });
    expect((await findUserById(k.db, uid(10)))?.id).toBe(uid(10));
    expect((await findUserById(k.db, uid(10), true))?.id).toBe(uid(10));
    expect(await findUserById(k.db, uid(11))).toBeUndefined();
    expect((await findUserByEmail(k.db, 'MIXED.case@example.test'))?.id).toBe(uid(10));
    expect(await findUserBySubject(k.db, 'sub-1')).toBeUndefined();
    expect(await bindSubject(k.db, uid(10), 'sub-1')).toBe(true);
    expect((await findUserBySubject(k.db, 'sub-1'))?.id).toBe(uid(10));
    expect(await bindSubject(k.db, uid(10), 'sub-2')).toBe(false);
    await insertUser(k.db, { ...person, id: uid(11), email: 'a@example.test', fullName: 'A' });
    expect((await listUsers(k.db)).map((u) => u.full_name)).toEqual(['A', 'P']);
  });

  it('hides soft-deleted users from every finder', async () => {
    await insertUser(k.db, person);
    await bindSubject(k.db, uid(10), 'sub-1');
    await k.db.query('update sys_users set deleted_at = now()');
    expect(await findUserById(k.db, uid(10))).toBeUndefined();
    expect(await findUserByEmail(k.db, person.email)).toBeUndefined();
    expect(await findUserBySubject(k.db, 'sub-1')).toBeUndefined();
    expect(await listUsers(k.db)).toEqual([]);
  });

  it('updates with the expected version and touches the login time', async () => {
    await insertUser(k.db, person);
    const updated = await updateUser(k.db, {
      id: uid(10),
      expectedVersion: 1,
      patch: { full_name: 'Q' },
      actor: uid(1),
    });
    expect(updated).toMatchObject({ full_name: 'Q', version: 2 });
    await expect(
      updateUser(k.db, { id: uid(10), expectedVersion: 1, patch: {}, actor: null }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await touchLogin(k.db, uid(10));
    expect((await findUserById(k.db, uid(10)))?.last_login_at).toBeInstanceOf(Date);
  });

  it('rejects duplicate emails and statuses outside the check constraint', async () => {
    await insertUser(k.db, person);
    await expect(insertUser(k.db, { ...person, id: uid(12) })).rejects.toThrow();
    await expect(k.db.query("update sys_users set status = 'gone'")).rejects.toThrow();
  });
});

describe('roles and scopes', () => {
  it('replaces and reads user roles and scopes', async () => {
    await insertUser(k.db, person);
    await replaceUserRoles(k.db, uid(10), ['storekeeper', 'accountant']);
    expect(await selectRoleCodes(k.db, uid(10))).toEqual(['accountant', 'storekeeper']);
    await replaceUserRoles(k.db, uid(10), ['storekeeper']);
    expect(await selectRoleCodes(k.db, uid(10))).toEqual(['storekeeper']);
    expect(await selectAllUserRoles(k.db)).toEqual([
      { user_id: uid(10), role_code: 'storekeeper' },
    ]);

    await replaceUserScopes(k.db, uid(10), [
      { type: 'team', id: uid(901) },
      { type: 'project', id: uid(900) },
    ]);
    expect(await selectScopes(k.db, uid(10))).toEqual([
      { type: 'project', id: uid(900) },
      { type: 'team', id: uid(901) },
    ]);
    expect(await selectAllScopes(k.db)).toHaveLength(2);
    await replaceUserScopes(k.db, uid(10), []);
    expect(await selectScopes(k.db, uid(10))).toEqual([]);
  });

  it('rejects a scope type outside the check constraint', async () => {
    await insertUser(k.db, person);
    await expect(
      k.db.query("insert into sys_user_scopes values ($1, 'site', $2)", [uid(10), uid(900)]),
    ).rejects.toThrow();
  });

  it('counts only active, undeleted admins', async () => {
    expect(await countActiveAdmins(k.db)).toBe(0);
    await seedUser(k.db, { id: uid(20), email: 'a1@example.test', roles: ['admin'] });
    await seedUser(k.db, {
      id: uid(21),
      email: 'a2@example.test',
      roles: ['admin'],
      status: 'disabled',
    });
    await seedUser(k.db, { id: uid(22), email: 'a3@example.test', roles: ['accountant'] });
    expect(await countActiveAdmins(k.db)).toBe(1);
    await k.db.query('update sys_users set deleted_at = now() where id = $1', [uid(20)]);
    expect(await countActiveAdmins(k.db)).toBe(0);
  });

  it('reads roles and registers a new one only once', async () => {
    expect((await listRoles(k.db)).map((r) => r.code)).toContain('admin');
    expect(await findRole(k.db, 'admin')).toMatchObject({ system: true });
    expect(await findRole(k.db, 'nope')).toBeUndefined();
    expect(await existingRoleCodes(k.db, ['admin', 'nope', 'estimator'])).toEqual(
      expect.arrayContaining(['admin', 'estimator']),
    );
    expect(await existingRoleCodes(k.db, ['nope'])).toEqual([]);
    expect(await insertRoleIfAbsent(k.db, { code: 'worker', name: 'W', description: 'd' })).toBe(
      true,
    );
    expect(await insertRoleIfAbsent(k.db, { code: 'worker', name: 'X', description: 'e' })).toBe(
      false,
    );
    expect(await findRole(k.db, 'worker')).toMatchObject({ name: 'W', system: false });
    await expect(
      insertRoleIfAbsent(k.db, { code: 'Bad Code', name: 'x', description: '' }),
    ).rejects.toThrow();
  });

  it('replaces role permissions and groups them per role', async () => {
    await replaceRolePermissions(k.db, 'estimator', ['q.r.read', 'q.r.write']);
    expect(await selectRolePermissions(k.db, ['estimator', 'storekeeper'])).toEqual([
      { code: 'estimator', permissions: ['q.r.read', 'q.r.write'] },
      { code: 'storekeeper', permissions: [] },
    ]);
    expect(await selectRolePermissions(k.db, [])).toEqual([]);
    await replaceRolePermissions(k.db, 'estimator', []);
    expect(
      (await selectAllRolePermissions(k.db)).filter((g) => g.role_code === 'estimator'),
    ).toEqual([]);
    await expect(replaceRolePermissions(k.db, 'estimator', ['not-a-code'])).rejects.toThrow();
    await expect(replaceRolePermissions(k.db, 'ghost', ['q.r.read'])).rejects.toThrow();
  });
});
