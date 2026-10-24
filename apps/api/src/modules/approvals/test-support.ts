import { createTestDb, type SqlDb } from '@emporium/db';
import { approvalsPermissions, identityPermissions, platformPermissions } from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createApprovals, type Approvals, type RuleSetInput } from './index.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('approvals-test-secret-approvals-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7777-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const OWNER = uid(2);
export const PM = uid(3);
export const PM2 = uid(4);
export const ESTIMATOR = uid(5);
export const SUPERVISOR = uid(6);
export const ACCOUNTANT = uid(7);

export const EMAILS: Record<string, string> = {
  [ADMIN]: 'admin@example.test',
  [OWNER]: 'owner@example.test',
  [PM]: 'pm@example.test',
  [PM2]: 'pm2@example.test',
  [ESTIMATOR]: 'estimator@example.test',
  [SUPERVISOR]: 'supervisor@example.test',
  [ACCOUNTANT]: 'accountant@example.test',
};

/** Two steps: a project manager pair, then the owner (management). Used by AC-1 and T-2. */
export const twoStepRules = (effectiveFrom = '2026-01-01'): RuleSetInput => ({
  effectiveFrom,
  bands: [
    {
      minAmount: '0',
      maxAmount: '100000',
      steps: [{ stepNo: 1, roleCode: 'project_manager', minApprovers: 1 }],
    },
    {
      minAmount: '100000',
      maxAmount: null,
      steps: [
        { stepNo: 1, roleCode: 'project_manager', minApprovers: 2 },
        { stepNo: 2, roleCode: 'management', minApprovers: 1 },
      ],
    },
  ],
});

export interface ApprovalsKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  approvals: Approvals;
  app: FastifyInstance;
  now: { current: Date };
  token(userId: string): Promise<string>;
  actor(userId: string, roles: string[], scopes?: Actor['scopes']): Actor;
  /** A document id that has not been used yet. */
  newDoc(): string;
  /** Registers `test_doc` with the two-step rules. */
  seedTestDoc(): Promise<void>;
  eventsFor(docId: string): Promise<string[]>;
  close(): Promise<void>;
}

let counter = 0;
let docCounter = 0;

export async function createApprovalsKit(): Promise<ApprovalsKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-24T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f8888-0000-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('approvals', Object.values(approvalsPermissions));
  const approvals = createApprovals({
    platform,
    clock,
    newId,
    roleCodes: async (tx) => (await identity.roles.list(tx)).map((role) => role.code),
  });

  for (const [id, role] of [
    [ADMIN, 'admin'],
    [OWNER, 'management'],
    [PM, 'project_manager'],
    [PM2, 'project_manager'],
    [ESTIMATOR, 'estimator'],
    [SUPERVISOR, 'supervisor'],
    [ACCOUNTANT, 'accountant'],
  ] as const) {
    const email = EMAILS[id] as string;
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
    approvals: { db, approvals, platform },
  });
  await app.ready();

  return {
    db,
    platform,
    identity,
    approvals,
    app,
    now,
    token: (userId) =>
      new SignJWT({ email: EMAILS[userId] })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(EMAILS[userId] as string)
        .setAudience(AUDIENCE)
        .setIssuedAt(Math.floor(now.current.getTime() / 1000))
        .setExpirationTime('1h')
        .sign(SECRET),
    actor: (userId, roles, scopes = []) => ({ userId, roles, scopes, requestId: null }),
    newDoc: () => `018f9999-0000-7000-8000-${String(++docCounter).padStart(12, '0')}`,
    async seedTestDoc() {
      await db.transaction((tx) =>
        approvals.rules.replaceRules(
          'test_doc',
          twoStepRules(),
          { userId: ADMIN, requestId: null },
          tx,
        ),
      );
    },
    async eventsFor(docId) {
      const rows = await db.query<{ type: string }>(
        `select type from sys_outbox where payload->>'docId' = $1 order by id`,
        [docId],
      );
      return rows.map((r) => r.type);
    },
    close: () => app.close(),
  };
}
