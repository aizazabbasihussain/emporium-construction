import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  identityPermissions,
  notificationsPermissions,
  platformPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { identityDirectory } from '../../compose.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals, type RuleSetInput } from '../approvals/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createNotifications, type Notifications } from './index.js';

const SECRET = new TextEncoder().encode('notify-test-secret-notify-test-secret-12');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7777-3333-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const OWNER = uid(2);
export const PM = uid(3);
export const PM2 = uid(4);
export const ESTIMATOR = uid(5);
/** Supervisors are scope-limited: each sees only the project assigned to them. */
export const SUPERVISOR = uid(6);
export const SUPERVISOR_OTHER = uid(8);
export const DISABLED_PM = uid(7);
export const PROJECT = uid(100);
export const OTHER_PROJECT = uid(101);

export const EMAILS: Record<string, string> = {
  [ADMIN]: 'admin@example.test',
  [OWNER]: 'owner@example.test',
  [PM]: 'pm@example.test',
  [PM2]: 'pm2@example.test',
  [ESTIMATOR]: 'estimator@example.test',
  [SUPERVISOR]: 'supervisor@example.test',
  [SUPERVISOR_OTHER]: 'supervisor2@example.test',
  [DISABLED_PM]: 'pm.disabled@example.test',
};

/** Step 1: project managers; step 2: the owner. Band above 100,000 has both steps. */
export const twoStepRules: RuleSetInput = {
  effectiveFrom: '2026-01-01',
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
        { stepNo: 1, roleCode: 'project_manager', minApprovers: 1 },
        { stepNo: 2, roleCode: 'management', minApprovers: 1 },
      ],
    },
  ],
};

export const supervisorRules: RuleSetInput = {
  effectiveFrom: '2026-01-01',
  bands: [
    {
      minAmount: '0',
      maxAmount: null,
      steps: [{ stepNo: 1, roleCode: 'supervisor', minApprovers: 1 }],
    },
  ],
};

export interface NotificationsKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  approvals: Approvals;
  notifications: Notifications;
  app: FastifyInstance;
  now: { current: Date };
  token(userId: string): Promise<string>;
  newDoc(): string;
  /** Registers `test_doc` with the two-step rules and `site_doc` with one supervisor step. */
  seedTestDoc(): Promise<void>;
  /** Runs the outbox dispatcher until nothing is left. */
  dispatch(): Promise<void>;
  /** The notifications of one user, oldest first. */
  inboxOf(userId: string): Promise<{ template: string; data: Record<string, unknown> }[]>;
  close(): Promise<void>;
}

let counter = 0;
let docCounter = 0;

export async function createNotificationsKit(): Promise<NotificationsKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f8888-3333-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('approvals', Object.values(approvalsPermissions));
  identity.registerPermissions('notifications', Object.values(notificationsPermissions));
  const approvals = createApprovals({
    platform,
    clock,
    newId,
    roleCodes: async (tx) => (await identity.roles.list(tx)).map((role) => role.code),
  });
  const notifications = createNotifications({
    platform,
    clock,
    newId,
    directory: identityDirectory(identity),
    getApprovalState: approvals.getApprovalState,
  });

  for (const [id, role] of [
    [ADMIN, 'admin'],
    [OWNER, 'management'],
    [PM, 'project_manager'],
    [PM2, 'project_manager'],
    [ESTIMATOR, 'estimator'],
    [SUPERVISOR, 'supervisor'],
    [SUPERVISOR_OTHER, 'supervisor'],
    [DISABLED_PM, 'project_manager'],
  ] as const) {
    const email = EMAILS[id] as string;
    await db.query(
      `insert into sys_users (id, auth_subject, email, full_name, status)
       values ($1, $2, $2, $2, $3)`,
      [id, email, id === DISABLED_PM ? 'disabled' : 'active'],
    );
    await db.query('insert into sys_user_roles (user_id, role_code) values ($1, $2)', [id, role]);
  }
  await db.query(
    `insert into sys_user_scopes (user_id, scope_type, scope_id) values ($1, 'project', $2)`,
    [SUPERVISOR, PROJECT],
  );
  await db.query(
    `insert into sys_user_scopes (user_id, scope_type, scope_id) values ($1, 'project', $2)`,
    [SUPERVISOR_OTHER, OTHER_PROJECT],
  );

  const app = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => now.current,
    identity: { db, identity },
    notifications: { db, notifications, platform },
  });
  await app.ready();

  return {
    db,
    platform,
    identity,
    approvals,
    notifications,
    app,
    now,
    token: (userId) =>
      new SignJWT({ email: EMAILS[userId] })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(EMAILS[userId] as string)
        .setAudience(AUDIENCE)
        .setIssuedAt(Math.floor(now.current.getTime() / 1000))
        .setExpirationTime(Math.floor(now.current.getTime() / 1000) + 3600)
        .sign(SECRET),
    newDoc: () => `018f9999-3333-7000-8000-${String(++docCounter).padStart(12, '0')}`,
    async seedTestDoc() {
      const actor = { userId: ADMIN, requestId: null };
      await db.transaction(async (tx) => {
        await approvals.rules.replaceRules('test_doc', twoStepRules, actor, tx);
        await approvals.rules.replaceRules('site_doc', supervisorRules, actor, tx);
      });
    },
    async dispatch() {
      for (let round = 0; round < 5; round += 1) {
        const summary = await platform.events.dispatchDue(db);
        if (summary.dispatched + summary.retrying + summary.failed === 0) return;
      }
    },
    inboxOf: (userId) =>
      db.query<{ template: string; data: Record<string, unknown> }>(
        'select template, data from ntf_notifications where user_id = $1 order by created_at, id',
        [userId],
      ),
    close: () => app.close(),
  };
}
