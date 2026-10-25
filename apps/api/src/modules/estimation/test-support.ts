import { createTestDb, type SqlDb } from '@emporium/db';
import {
  estimationPermissions,
  identityPermissions,
  masterdataPermissions,
  platformPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createEstimation, type Estimation } from './index.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('estimation-test-secret-estimation-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-3333-7000-8000-${String(n).padStart(12, '0')}`;

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

export interface EstimationKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  estimation: Estimation;
  app: FastifyInstance;
  now: { current: Date };
  actor: Actor;
  /** Seeded top-level cost codes by kind (ids). */
  costCodes: Record<'material' | 'labour' | 'subcontract' | 'equipment' | 'overhead', string>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;

export async function createEstimationKit(): Promise<EstimationKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-3333-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('estimation', Object.values(estimationPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  const masterData = createMasterData({
    platform,
    clock,
    newId,
    registerImporter: () => undefined,
  });
  const estimation = createEstimation({ platform, clock, newId, masterData });

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
    estimation: { db, estimation, platform },
  });
  await app.ready();

  const codes = await masterData.costing.listCostCodes(db);
  const codeOf = (kind: string) => (codes.find((c) => c.kind === kind) as { id: string }).id;
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  return {
    db,
    platform,
    identity,
    masterData,
    estimation,
    app,
    now,
    actor: { userId: ADMIN, requestId: null },
    costCodes: {
      material: codeOf('material'),
      labour: codeOf('labour'),
      subcontract: codeOf('subcontract'),
      equipment: codeOf('equipment'),
      overhead: codeOf('overhead'),
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
