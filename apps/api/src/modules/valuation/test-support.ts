import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  identityPermissions,
  masterdataPermissions,
  platformPermissions,
  valuationPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals } from '../approvals/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createValuation, type Valuation } from './index.js';
import type { PolicyInput } from './service/policies.service.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('valuation-test-secret-valuation-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-3333-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const ACCOUNTANT = uid(3);
export const STOREKEEPER = uid(4);
export const NOBODY = uid(5);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [STOREKEEPER, 'storekeeper@example.test', 'storekeeper'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

/** Opaque store ids: valuation never looks them up. */
export const STORE_A = uid(101);
export const STORE_B = uid(102);

/** Master data fixtures: a category tree and three items. */
export const CAT_MATERIALS = uid(201);
export const CAT_CEMENT = uid(202);
export const CAT_STEEL = uid(203);
export const ITEM_CEMENT = uid(301); // in CAT_CEMENT, a child of CAT_MATERIALS
export const ITEM_STEEL = uid(302); // in CAT_STEEL, a child of CAT_MATERIALS
export const ITEM_SAND = uid(303); // no category

export const TODAY = '2026-10-25';
export const TOMORROW = '2026-10-26';

export interface ValuationKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  valuation: Valuation;
  app: FastifyInstance;
  now: { current: Date };
  actor: Actor;
  /** Runs `fn` in a transaction as the accountant. */
  tx<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
  /** A unique idempotency key. */
  key(): string;
  /** Requests a policy as the accountant, has the owner approve it and delivers the events. */
  activatePolicy(input: PolicyInput): Promise<string>;
  /** Requests a policy and leaves it waiting for approval. */
  requestPolicy(input: PolicyInput): Promise<string>;
  decide(policyId: string, action: 'approve' | 'reject'): Promise<void>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let keyCounter = 0;

export async function createValuationKit(): Promise<ValuationKit> {
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
  identity.registerPermissions('approvals', Object.values(approvalsPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('valuation', Object.values(valuationPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  const masterData = createMasterData({
    platform,
    clock,
    newId,
    registerImporter: () => undefined,
  });
  const approvals = createApprovals({
    platform,
    clock,
    newId,
    roleCodes: async (tx) => (await identity.roles.list(tx)).map((role) => role.code),
  });
  const valuation = createValuation({ platform, clock, newId, masterData, approvals });

  for (const [id, email, role] of USERS) {
    await db.query(
      `insert into sys_users (id, auth_subject, email, full_name) values ($1, $2, $2, $2)`,
      [id, email],
    );
    await db.query('insert into sys_user_roles (user_id, role_code) values ($1, $2)', [id, role]);
  }

  for (const [id, code, parent] of [
    [CAT_MATERIALS, 'MAT', null],
    [CAT_CEMENT, 'CEM', CAT_MATERIALS],
    [CAT_STEEL, 'STL', CAT_MATERIALS],
  ] as const) {
    await db.query(
      'insert into mst_item_categories (id, code, name, parent_id) values ($1, $2, $2, $3)',
      [id, code, parent],
    );
  }
  for (const [id, code, category] of [
    [ITEM_CEMENT, 'CEMENT', CAT_CEMENT],
    [ITEM_STEEL, 'STEEL', CAT_STEEL],
    [ITEM_SAND, 'SAND', null],
  ] as const) {
    await db.query(
      `insert into mst_items (id, code, name, category_id, unit_code, item_kind, stockable, default_tax_kind)
       values ($1, $2, $2, $3, 'nos', 'material', true, 'goods')`,
      [id, code, category],
    );
  }

  const app = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => now.current,
    identity: { db, identity },
    valuation: { db, valuation, platform },
  });
  await app.ready();

  const actor: Actor = { userId: ACCOUNTANT, requestId: null };
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;

  const requestPolicy = (input: PolicyInput) =>
    db.transaction(async (tx) => (await valuation.setPolicy(input, actor, tx)).id);

  const decide = async (policyId: string, action: 'approve' | 'reject') => {
    const state = await approvals.getApprovalState(db, 'valuation_policy', policyId);
    if (state.status === 'none') throw new Error('no approval request');
    await db.transaction((tx) =>
      approvals.service.act(
        state.id,
        action,
        { comment: action === 'reject' ? 'Not now' : null },
        { userId: MANAGEMENT, roles: ['management'], scopes: [], requestId: null },
        tx,
      ),
    );
    await platform.events.dispatchDue(db);
  };

  return {
    db,
    platform,
    identity,
    masterData,
    approvals,
    valuation,
    app,
    now,
    actor,
    tx: (fn) => db.transaction(fn),
    key: () => `k-${++keyCounter}`,
    requestPolicy,
    decide,
    async activatePolicy(input) {
      const id = await requestPolicy(input);
      await decide(id, 'approve');
      return id;
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
