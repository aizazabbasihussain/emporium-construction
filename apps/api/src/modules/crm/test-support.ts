import { randomUUID } from 'node:crypto';
import { createTestDb, type SqlDb } from '@emporium/db';
import {
  crmPermissions,
  filesPermissions,
  identityPermissions,
  masterdataPermissions,
  platformPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createFiles, type Files, type FileStore } from '../files/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createNotifications, type Notifications } from '../notifications/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createCrm, type Crm } from './index.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('crm-test-secret-crm-test-secret-crm-test');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-2222-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const ACCOUNTANT = uid(4);
export const SUPERVISOR = uid(5);
export const NOBODY = uid(6);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

export interface CrmKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  notifications: Notifications;
  files: Files;
  crm: Crm;
  app: FastifyInstance;
  now: { current: Date };
  actor: Actor;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;

/** An in-memory object store: the tests never touch the disk or the network. */
function memoryStore(): FileStore {
  const objects = new Map<string, Uint8Array>();
  return {
    put: (key, bytes) => {
      objects.set(key, bytes);
      return Promise.resolve();
    },
    getSignedUrl: (key) => Promise.resolve(`https://files.example.test/${key}`),
    delete: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
    exists: (key) => Promise.resolve(objects.has(key)),
  };
}

export async function createCrmKit(): Promise<CrmKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-1111-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('files', Object.values(filesPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('crm', Object.values(crmPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  const masterData = createMasterData({
    platform,
    clock,
    newId,
    registerImporter: () => undefined,
  });
  const notifications = createNotifications({
    platform,
    clock,
    newId,
    directory: { usersWithRole: () => Promise.resolve([]) },
    getApprovalState: () => Promise.resolve({ status: 'none' }),
  });
  const files = createFiles({ platform, clock, newId, newKey: randomUUID, store: memoryStore() });
  const crm = createCrm({ platform, clock, newId, masterData, notifications, files });

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
    files: { db, files, platform },
    crm: { db, crm, platform },
  });
  await app.ready();

  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  return {
    db,
    platform,
    identity,
    masterData,
    notifications,
    files,
    crm,
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
