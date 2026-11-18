import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  identityPermissions,
  masterdataPermissions,
  platformPermissions,
  taxPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals } from '../approvals/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createTax, type Tax } from './index.js';
import type {
  RegionEntryInput,
  SalesRuleInput,
  WithholdingRuleInput,
} from './service/rules.service.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('tax-test-secret-tax-test-secret-tax-test');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-4444-7000-8000-${String(n).padStart(12, '0')}`;

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

export const TODAY = '2026-11-17';
export const FROM = '2026-01-01';

/**
 * Synthetic rules used by the tests only. The engine ships with none (BR-9); the rates here are
 * test values and mean nothing.
 */
export const TEST_SALES: SalesRuleInput = {
  authorityCode: 'FBR',
  supplyKind: 'services',
  ratePercent: '10',
  taxCode: 'TEST-ST',
  effectiveFrom: FROM,
};

export interface TaxKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  tax: Tax;
  app: FastifyInstance;
  now: { current: Date };
  actor: Actor;
  /** Ids of the two locations created for the tests. */
  islamabadId: string;
  lahoreId: string;
  tx<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
  key(): string;
  /** Requests a rule as the accountant and leaves it waiting. */
  requestSales(input: SalesRuleInput): Promise<string>;
  requestWithholding(input: WithholdingRuleInput): Promise<string>;
  requestRegion(input: RegionEntryInput): Promise<string>;
  decide(docId: string, action: 'approve' | 'reject'): Promise<void>;
  approveSales(input: SalesRuleInput): Promise<string>;
  approveWithholding(input: WithholdingRuleInput): Promise<string>;
  approveRegion(input: RegionEntryInput): Promise<string>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let keyCounter = 0;

export async function createTaxKit(): Promise<TaxKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-11-17T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-4444-7000-8000-${String(++counter).padStart(12, '0')}`;
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
  identity.registerPermissions('tax', Object.values(taxPermissions));
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
  const tax = createTax({ platform, clock, newId, masterData, approvals });

  for (const [id, email, role] of USERS) {
    await db.query(
      `insert into sys_users (id, auth_subject, email, full_name) values ($1, $2, $2, $2)`,
      [id, email],
    );
    await db.query('insert into sys_user_roles (user_id, role_code) values ($1, $2)', [id, role]);
  }

  const actor: Actor = { userId: ACCOUNTANT, requestId: null };
  const islamabad = await db.transaction((tx) =>
    masterData.company.createLocation(
      { name: 'Test site Islamabad', region: 'islamabad', city: 'Islamabad' },
      actor,
      tx,
    ),
  );
  const lahore = await db.transaction((tx) =>
    masterData.company.createLocation(
      { name: 'Test site Lahore', region: 'punjab', city: 'Lahore' },
      actor,
      tx,
    ),
  );
  // The company is registered with FBR only (H-01); the registration number is a test value.
  await db.transaction((tx) =>
    masterData.company.createRegistration(
      {
        authority: 'FBR',
        registrationType: 'strn',
        number: 'TEST-FBR-0001',
        validFrom: '2020-01-01',
      },
      actor,
      tx,
    ),
  );

  const app = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => now.current,
    identity: { db, identity },
    tax: { db, tax, platform },
  });
  await app.ready();

  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;

  const decide = async (docId: string, action: 'approve' | 'reject') => {
    const state = await approvals.getApprovalState(db, 'tax_rule', docId);
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

  const requestSales = (input: SalesRuleInput) =>
    db.transaction(async (tx) => (await tax.rules.requestSalesRule(input, actor, tx)).id);
  const requestWithholding = (input: WithholdingRuleInput) =>
    db.transaction(async (tx) => (await tax.rules.requestWithholdingRule(input, actor, tx)).id);
  const requestRegion = (input: RegionEntryInput) =>
    db.transaction(async (tx) => (await tax.rules.requestRegionEntry(input, actor, tx)).id);
  const approving =
    <I>(request: (input: I) => Promise<string>) =>
    async (input: I) => {
      const id = await request(input);
      await decide(id, 'approve');
      return id;
    };

  return {
    db,
    platform,
    identity,
    masterData,
    approvals,
    tax,
    app,
    now,
    actor,
    islamabadId: islamabad.id,
    lahoreId: lahore.id,
    tx: (fn) => db.transaction(fn),
    key: () => `k-${++keyCounter}`,
    requestSales,
    requestWithholding,
    requestRegion,
    decide,
    approveSales: approving(requestSales),
    approveWithholding: approving(requestWithholding),
    approveRegion: approving(requestRegion),
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
