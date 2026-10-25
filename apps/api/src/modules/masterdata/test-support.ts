import { createTestDb, type SqlDb } from '@emporium/db';
import {
  identityPermissions,
  importerPermissions,
  masterdataPermissions,
  platformPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createImporter, type Importer } from '../importer/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createMasterData, type MasterData } from './index.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('masterdata-test-secret-masterdata-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-1111-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const PROCUREMENT = uid(2);
export const ACCOUNTANT = uid(3);
export const STOREKEEPER = uid(4);
export const SUPERVISOR = uid(5);
export const NOBODY = uid(6);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [PROCUREMENT, 'procurement@example.test', 'procurement'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [STOREKEEPER, 'storekeeper@example.test', 'storekeeper'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

export interface MasterKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  importer: Importer;
  masterData: MasterData;
  app: FastifyInstance;
  now: { current: Date };
  actor: Actor;
  /** An authorization header for one of the seeded users. */
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;

export async function createMasterKit(): Promise<MasterKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7b7b-1111-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('importer', Object.values(importerPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  const importer = createImporter({ platform, clock, newId });
  const masterData = createMasterData({
    platform,
    clock,
    newId,
    registerImporter: (definition) => importer.registerImporter(definition),
  });

  for (const [id, email, role] of USERS) {
    await db.query(
      `insert into sys_users (id, auth_subject, email, full_name) values ($1, $2, $2, $2)`,
      [id, email],
    );
    await db.query('insert into sys_user_roles (user_id, role_code) values ($1, $2)', [id, role]);
  }

  const app = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => now.current,
    identity: { db, identity },
    masterData: { db, masterData, platform },
  });
  await app.ready();

  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  return {
    db,
    platform,
    identity,
    importer,
    masterData,
    app,
    now,
    actor: { userId: ADMIN, requestId: null },
    async auth(userId) {
      const email = emailOf(userId);
      const token = await new SignJWT({ email })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(email)
        .setAudience(AUDIENCE)
        .setIssuedAt(Math.floor(now.current.getTime() / 1000))
        .setExpirationTime(Math.floor(now.current.getTime() / 1000) + 3600)
        .sign(SECRET);
      return { authorization: `Bearer ${token}` };
    },
    close: () => app.close(),
  };
}

/** Counts rows of an audit action, for the "every mutation is audited" checks. */
export async function auditCount(db: SqlDb, action: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    'select count(*) as n from sys_audit_log where action = $1',
    [action],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function eventCount(db: SqlDb, type: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    'select count(*) as n from sys_outbox where type = $1',
    [type],
  );
  return Number(rows[0]?.n ?? 0);
}
