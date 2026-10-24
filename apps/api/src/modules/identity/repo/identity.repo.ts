import { updateWithVersion } from '@emporium/db';
import type { ScopeGrant } from '@emporium/domain/identity';
import type { Db } from '../types.js';

export interface UserRow {
  id: string;
  auth_subject: string | null;
  email: string;
  full_name: string;
  phone: string | null;
  status: 'active' | 'disabled';
  locale: string;
  last_login_at: Date | null;
  version: number;
}

export interface RoleRow {
  code: string;
  name: string;
  description: string;
  system: boolean;
}

const USER_COLUMNS =
  'id, auth_subject, email, full_name, phone, status, locale, last_login_at, version';

export async function findUserBySubject(db: Db, subject: string): Promise<UserRow | undefined> {
  const rows = await db.query<UserRow>(
    `select ${USER_COLUMNS} from sys_users where auth_subject = $1 and deleted_at is null`,
    [subject],
  );
  return rows[0];
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const rows = await db.query<UserRow>(
    `select ${USER_COLUMNS} from sys_users where email = $1 and deleted_at is null`,
    [email.toLowerCase()],
  );
  return rows[0];
}

/** `lock` takes a row lock so concurrent admin edits of one user queue up. */
export async function findUserById(db: Db, id: string, lock = false): Promise<UserRow | undefined> {
  const rows = await db.query<UserRow>(
    `select ${USER_COLUMNS} from sys_users where id = $1 and deleted_at is null${lock ? ' for update' : ''}`,
    [id],
  );
  return rows[0];
}

export function listUsers(db: Db): Promise<UserRow[]> {
  return db.query<UserRow>(
    `select ${USER_COLUMNS} from sys_users where deleted_at is null order by full_name, email`,
  );
}

export async function insertUser(
  db: Db,
  user: {
    id: string;
    email: string;
    fullName: string;
    phone: string | null;
    actor: string | null;
  },
): Promise<UserRow> {
  const rows = await db.query<UserRow>(
    `insert into sys_users (id, email, full_name, phone, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $5)
     returning ${USER_COLUMNS}`,
    [user.id, user.email.toLowerCase(), user.fullName, user.phone, user.actor],
  );
  return rows[0] as UserRow;
}

export function updateUser(
  db: Db,
  update: {
    id: string;
    expectedVersion: number;
    patch: Record<string, unknown>;
    actor: string | null;
  },
): Promise<UserRow> {
  return updateWithVersion<UserRow>(db, {
    table: 'sys_users',
    id: update.id,
    expectedVersion: update.expectedVersion,
    patch: update.patch,
    actorUserId: update.actor,
  });
}

/** Binds the Supabase subject on first login (BR-2); returns false if it was bound meanwhile. */
export async function bindSubject(db: Db, userId: string, subject: string): Promise<boolean> {
  const rows = await db.query(
    `update sys_users
        set auth_subject = $2, last_login_at = now(), version = version + 1,
            updated_at = now(), updated_by = $1
      where id = $1 and auth_subject is null and deleted_at is null
      returning id`,
    [userId, subject],
  );
  return rows.length === 1;
}

export async function touchLogin(db: Db, userId: string): Promise<void> {
  await db.query('update sys_users set last_login_at = now() where id = $1', [userId]);
}

export async function selectRoleCodes(db: Db, userId: string): Promise<string[]> {
  const rows = await db.query<{ role_code: string }>(
    'select role_code from sys_user_roles where user_id = $1 order by role_code',
    [userId],
  );
  return rows.map((row) => row.role_code);
}

export async function selectRolePermissions(
  db: Db,
  roleCodes: readonly string[],
): Promise<{ code: string; permissions: string[] }[]> {
  const rows = await db.query<{ role_code: string; permission_code: string }>(
    `select role_code, permission_code from sys_role_permissions
      where role_code = any($1::text[]) order by role_code, permission_code`,
    [roleCodes],
  );
  return roleCodes.map((code) => ({
    code,
    permissions: rows.filter((row) => row.role_code === code).map((row) => row.permission_code),
  }));
}

export async function selectScopes(db: Db, userId: string): Promise<ScopeGrant[]> {
  const rows = await db.query<{ scope_type: ScopeGrant['type']; scope_id: string }>(
    'select scope_type, scope_id from sys_user_scopes where user_id = $1 order by scope_type, scope_id',
    [userId],
  );
  return rows.map((row) => ({ type: row.scope_type, id: row.scope_id }));
}

export function selectAllUserRoles(db: Db): Promise<{ user_id: string; role_code: string }[]> {
  return db.query('select user_id, role_code from sys_user_roles order by role_code');
}

export async function selectAllScopes(
  db: Db,
): Promise<{ user_id: string; scope_type: ScopeGrant['type']; scope_id: string }[]> {
  return db.query(
    'select user_id, scope_type, scope_id from sys_user_scopes order by scope_type, scope_id',
  );
}

export async function replaceUserRoles(
  db: Db,
  userId: string,
  roleCodes: readonly string[],
): Promise<void> {
  await db.query('delete from sys_user_roles where user_id = $1', [userId]);
  for (const code of roleCodes) {
    await db.query('insert into sys_user_roles (user_id, role_code) values ($1, $2)', [
      userId,
      code,
    ]);
  }
}

export async function replaceUserScopes(
  db: Db,
  userId: string,
  scopes: readonly ScopeGrant[],
): Promise<void> {
  await db.query('delete from sys_user_scopes where user_id = $1', [userId]);
  for (const scope of scopes) {
    await db.query(
      'insert into sys_user_scopes (user_id, scope_type, scope_id) values ($1, $2, $3)',
      [userId, scope.type, scope.id],
    );
  }
}

/** Active admins, locked so two concurrent demotions cannot both pass the last-admin check (BR-5). */
export async function countActiveAdmins(db: Db): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `select u.id from sys_users u
       join sys_user_roles r on r.user_id = u.id and r.role_code = 'admin'
      where u.status = 'active' and u.deleted_at is null
        for update of u`,
  );
  return rows.length;
}

export function listRoles(db: Db): Promise<RoleRow[]> {
  return db.query<RoleRow>('select code, name, description, system from sys_roles order by code');
}

export async function findRole(db: Db, code: string): Promise<RoleRow | undefined> {
  const rows = await db.query<RoleRow>(
    'select code, name, description, system from sys_roles where code = $1',
    [code],
  );
  return rows[0];
}

export async function existingRoleCodes(db: Db, codes: readonly string[]): Promise<string[]> {
  const rows = await db.query<{ code: string }>(
    'select code from sys_roles where code = any($1::text[])',
    [codes],
  );
  return rows.map((row) => row.code);
}

export function selectAllRolePermissions(
  db: Db,
): Promise<{ role_code: string; permission_code: string }[]> {
  return db.query(
    'select role_code, permission_code from sys_role_permissions order by role_code, permission_code',
  );
}

export async function insertRoleIfAbsent(
  db: Db,
  role: { code: string; name: string; description: string },
): Promise<boolean> {
  const rows = await db.query(
    `insert into sys_roles (code, name, description, system) values ($1, $2, $3, false)
     on conflict (code) do nothing returning code`,
    [role.code, role.name, role.description],
  );
  return rows.length === 1;
}

export async function replaceRolePermissions(
  db: Db,
  roleCode: string,
  permissions: readonly string[],
): Promise<void> {
  await db.query('delete from sys_role_permissions where role_code = $1', [roleCode]);
  for (const permission of permissions) {
    await db.query(
      'insert into sys_role_permissions (role_code, permission_code) values ($1, $2)',
      [roleCode, permission],
    );
  }
}
