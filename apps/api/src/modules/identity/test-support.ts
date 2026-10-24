import { createTestDb, type SqlDb } from '@emporium/db';
import {
  identityPermissionGrants,
  identityPermissions,
  platformPermissionGrants,
  platformPermissions,
} from '@emporium/shared';
import { SignJWT } from 'jose';
import { createIdentity, createJwtVerifier, type Identity } from './index.js';
import { createPlatform, type Platform } from '../platform/index.js';

export const SECRET = new TextEncoder().encode('identity-test-secret-identity-test-secret');
export const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f2222-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGER = uid(2);
export const SUPERVISOR = uid(3);
export const STOREKEEPER = uid(4);

export interface IdentityKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  now: { current: Date };
  /** Signs a token the verifier accepts, unless overridden. */
  token(subject: string, email?: string | null, options?: { expiresIn?: string }): Promise<string>;
}

let counter = 0;

export async function createIdentityKit(): Promise<IdentityKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-24T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const ids = () => `018f3333-0000-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId: ids });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId: ids,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  return {
    db,
    platform,
    identity,
    now,
    token: (subject, email = `${subject}@example.test`, options = {}) => {
      const jwt = new SignJWT(email === null ? {} : { email })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(subject)
        .setAudience(AUDIENCE)
        .setIssuedAt(Math.floor(now.current.getTime() / 1000))
        .setExpirationTime(options.expiresIn ?? '1h');
      return jwt.sign(SECRET);
    },
  };
}

/** Inserts a user straight into the table (bypassing the service) with the given roles. */
export async function seedUser(
  db: SqlDb,
  user: {
    id: string;
    email: string;
    roles: string[];
    subject?: string | null;
    status?: 'active' | 'disabled';
    fullName?: string;
  },
): Promise<void> {
  await db.query(
    `insert into sys_users (id, auth_subject, email, full_name, status)
     values ($1, $2, $3, $4, $5)`,
    [
      user.id,
      user.subject === undefined ? user.email : user.subject,
      user.email,
      user.fullName ?? user.email,
      user.status ?? 'active',
    ],
  );
  for (const role of user.roles) {
    await db.query('insert into sys_user_roles (user_id, role_code) values ($1, $2)', [
      user.id,
      role,
    ]);
  }
}

/** The standard cast: an admin, a manager, a supervisor and a storekeeper, subject = email. */
export async function seedCast(db: SqlDb): Promise<void> {
  await seedUser(db, { id: ADMIN, email: 'admin@example.test', roles: ['admin'] });
  await seedUser(db, { id: MANAGER, email: 'manager@example.test', roles: ['management'] });
  await seedUser(db, { id: SUPERVISOR, email: 'supervisor@example.test', roles: ['supervisor'] });
  await seedUser(db, {
    id: STOREKEEPER,
    email: 'storekeeper@example.test',
    roles: ['storekeeper'],
  });
}

/** Returns the identity tables to their migrated state so one database serves a whole test file. */
export async function resetIdentity(db: SqlDb): Promise<void> {
  for (const table of [
    'sys_user_scopes',
    'sys_user_roles',
    'sys_users',
    'sys_event_consumptions',
    'sys_outbox',
    'sys_idempotency',
    'sys_role_permissions',
  ]) {
    await db.query(`delete from ${table}`);
  }
  await db.query('delete from sys_roles where system = false');
  const grants = { ...identityPermissionGrants, ...platformPermissionGrants };
  for (const [permission, roles] of Object.entries(grants)) {
    for (const role of roles) {
      await db.query(
        'insert into sys_role_permissions (role_code, permission_code) values ($1, $2)',
        [role, permission],
      );
    }
  }
}
