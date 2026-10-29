import { createTestDb, type SqlDb } from '@emporium/db';
import type { UnapprovedSheet } from '@emporium/domain/workforce';
import {
  identityPermissions,
  importerPermissions,
  masterdataPermissions,
  platformPermissions,
  workforcePermissionGrants,
  workforcePermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createImporter, type Importer } from '../importer/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createWorkforce, type Workforce } from './index.js';
import type { CreateWorkerInput } from './service/workers.service.js';
import type { Actor, TeamDto, WorkerDto } from './types.js';

const SECRET = new TextEncoder().encode('workforce-test-secret-workforce-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-9999-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const ACCOUNTANT = uid(4);
export const SUPERVISOR = uid(5);
export const SUPERVISOR2 = uid(6);
export const NOBODY = uid(7);
export const STOREKEEPER = uid(8);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [SUPERVISOR2, 'supervisor2@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
  [STOREKEEPER, 'storekeeper@example.test', 'storekeeper'],
];

export interface WorkforceKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  importer: Importer;
  workforce: Workforce;
  app: FastifyInstance;
  now: { current: Date };
  /** The attendance sheets the fake attendance interface reports as not approved. */
  unapproved: { sheets: UnapprovedSheet[]; asked: { workerId: string; upTo: string }[] };
  /** A caller with the permissions its role gets from the migration grants and its stored scopes. */
  actor(userId: string): Promise<Actor>;
  worker(over?: Partial<CreateWorkerInput>, by?: string): Promise<WorkerDto>;
  team(over?: { name?: string; supervisorUserId?: string; code?: string }): Promise<TeamDto>;
  /** A labour contractor party of the master data. */
  contractor(): Promise<string>;
  setSetting(key: string, value: unknown): Promise<void>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let workerSeq = 0;
let cnicSeq = 0;
let teamSeq = 0;

/** A different synthetic 13-digit CNIC every time. */
export const nextCnic = () => String(3520100000000 + ++cnicSeq);

export async function createWorkforceKit(): Promise<WorkforceKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-9999-7000-8000-${String(++counter).padStart(12, '0')}`;
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
  identity.registerPermissions('workforce', Object.values(workforcePermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  const importer = createImporter({ platform, clock, newId });
  const masterData = createMasterData({
    platform,
    clock,
    newId,
    registerImporter: (definition) => importer.registerImporter(definition),
  });
  const unapproved: WorkforceKit['unapproved'] = { sheets: [], asked: [] };
  const workforce = createWorkforce({
    platform,
    clock,
    newId,
    identity,
    masterData,
    attendance: {
      async listUnapprovedSheets(_db, workerId, upTo) {
        unapproved.asked.push({ workerId, upTo });
        return unapproved.sheets;
      },
    },
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
    workforce: { db, workforce, platform },
  });
  await app.ready();

  const rolesOf = (userId: string) => USERS.filter(([id]) => id === userId).map(([, , r]) => r);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  const admin = { userId: ADMIN, requestId: null };

  const kit: WorkforceKit = {
    db,
    platform,
    identity,
    masterData,
    importer,
    workforce,
    app,
    now,
    unapproved,

    async actor(userId) {
      const roles = rolesOf(userId);
      const user = (await identity.users.list(db)).find((candidate) => candidate.id === userId);
      return {
        userId,
        roles,
        scopes: user?.scopes ?? [],
        permissions: new Set<string>(
          Object.entries(workforcePermissionGrants)
            .filter(([, granted]) => granted.some((role) => roles.includes(role)))
            .map(([permission]) => permission),
        ),
        requestId: null,
      };
    },

    async worker(over = {}, by = MANAGEMENT) {
      workerSeq += 1;
      const actor = await kit.actor(by);
      return db.transaction((tx) =>
        workforce.workers.create(
          {
            fullName: `Synthetic Worker ${workerSeq}`,
            cnic: nextCnic(),
            phone: '0300 1234567',
            tradeCode: 'mason',
            employmentType: 'daily',
            joinedOn: '2026-01-01',
            ...over,
          },
          actor,
          tx,
        ),
      );
    },

    async team(over = {}) {
      teamSeq += 1;
      const actor = await kit.actor(MANAGEMENT);
      return db.transaction((tx) =>
        workforce.teams.create(
          { name: `Synthetic team ${teamSeq}`, supervisorUserId: SUPERVISOR, ...over },
          actor,
          tx,
        ),
      );
    },

    async contractor() {
      const party = await db.transaction((tx) =>
        masterData.parties.create(
          {
            name: `Synthetic Contractor ${++workerSeq}`,
            roles: ['labour_contractor'],
            city: 'Lahore',
          },
          admin,
          tx,
        ),
      );
      return party.id;
    },

    async setSetting(key, value) {
      const current = await platform.settings.get(db, key);
      await db.transaction((tx) =>
        platform.settings.set(
          { key, value, expectedVersion: current.version },
          { actorUserId: ADMIN, requestId: null },
          tx,
        ),
      );
    },

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

    async close() {
      await app.close();
    },
  };
  return kit;
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
