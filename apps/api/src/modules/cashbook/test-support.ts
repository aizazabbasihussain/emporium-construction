import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  cashbookPermissions,
  identityPermissions,
  platformPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals } from '../approvals/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createCashbook, type Cashbook } from './index.js';
import type { AccountInput } from './service/accounts.service.js';
import type { Actor, AccountDto, TransactionDto } from './types.js';

const SECRET = new TextEncoder().encode('cashbook-test-secret-cashbook-test-secret-1');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-7777-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const ACCOUNTANT = uid(3);
export const NOBODY = uid(5);
/** A second accountant, so one can record what the other requested. */
export const ACCOUNTANT_TWO = uid(6);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [NOBODY, 'nobody@example.test', 'nopower'],
  [ACCOUNTANT_TWO, 'accountant2@example.test', 'accountant'],
];

/** "Today" of every kit: the clock is fixed here. */
export const TODAY = '2026-11-18';

export interface CashbookKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  approvals: Approvals;
  cashbook: Cashbook;
  app: FastifyInstance;
  now: { current: Date };
  /** The accountant, who holds every cash book permission. */
  actor: Actor;
  actorFor(userId: string): Actor;
  tx<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
  account(over?: Partial<AccountInput>): Promise<AccountDto>;
  /** A receipt of the amount into the account, dated today. */
  receive(
    accountId: string,
    amount: string,
    over?: Partial<TransactionDto>,
  ): Promise<TransactionDto>;
  pay(accountId: string, amount: string): Promise<TransactionDto>;
  /** A payment request approved by the owner; returns the approval doc id. */
  approvedRequest(
    docType: 'payment' | 'cash_adjustment',
    amount: string,
    requester?: string,
  ): Promise<string>;
  decide(docType: string, docId: string, action: 'approve' | 'reject'): Promise<void>;
  setting(key: string, value: string | number | boolean): Promise<void>;
  balance(accountId: string, date?: string): Promise<string>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let accountCounter = 0;

export async function createCashbookKit(): Promise<CashbookKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-11-18T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-7777-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('approvals', Object.values(approvalsPermissions));
  identity.registerPermissions('cashbook', Object.values(cashbookPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  const approvals = createApprovals({
    platform,
    clock,
    newId,
    roleCodes: async (tx) => (await identity.roles.list(tx)).map((role) => role.code),
  });
  const cashbook = createCashbook({ platform, clock, newId, approvals });

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
    cashbook: { db, cashbook, platform },
  });
  await app.ready();

  const permissions = new Set<string>(Object.values(cashbookPermissions));
  const actorFor = (userId: string): Actor => ({
    userId,
    roles: USERS.filter(([id]) => id === userId).map(([, , role]) => role),
    scopes: [],
    permissions,
    requestId: null,
  });
  const actor = actorFor(ACCOUNTANT);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  const tx = <T>(fn: (t: SqlDb) => Promise<T>) => db.transaction(fn);
  const management = { userId: MANAGEMENT, roles: ['management'], scopes: [], requestId: null };

  const decide: CashbookKit['decide'] = async (docType, docId, action) => {
    const state = await approvals.getApprovalState(db, docType, docId);
    if (state.status === 'none') throw new Error('no approval request');
    await tx((t) =>
      approvals.service.act(
        state.id,
        action,
        { comment: action === 'approve' ? null : 'No' },
        management,
        t,
      ),
    );
    await platform.events.dispatchDue(db);
  };

  const kit: CashbookKit = {
    db,
    platform,
    identity,
    approvals,
    cashbook,
    app,
    now,
    actor,
    actorFor,
    tx,
    decide,

    account: (over = {}) =>
      tx((t) =>
        cashbook.accounts.create(
          {
            code: `ACC-${++accountCounter}`,
            name: `Account ${accountCounter}`,
            kind: 'bank',
            openingBalance: '0',
            openingDate: '2026-01-01',
            ...over,
          },
          actor,
          t,
        ),
      ),

    receive: (accountId, amount, over = {}) =>
      tx((t) =>
        cashbook.recordReceipt(
          { accountId, txnDate: over.txnDate ?? TODAY, amount, method: 'cash' },
          actor,
          t,
        ),
      ),

    pay: async (accountId, amount) => {
      await kit.setting('cashbook.payment_approval_threshold', '999999999');
      return tx((t) =>
        cashbook.recordPayment({ accountId, txnDate: TODAY, amount, method: 'cash' }, actor, t),
      );
    },

    async approvedRequest(docType, amount, requester = ACCOUNTANT) {
      const { approvalDocId } = await tx((t) =>
        cashbook.transactions.requestApproval({ docType, amount }, actorFor(requester), t),
      );
      await decide(docType, approvalDocId, 'approve');
      return approvalDocId;
    },

    async setting(key, value) {
      const current = await platform.settings.get(db, key);
      await tx((t) =>
        platform.settings.set(
          { key, value, expectedVersion: current.version },
          { actorUserId: ADMIN, requestId: null },
          t,
        ),
      );
    },

    balance: (accountId, date = TODAY) => cashbook.getAccountBalance(db, accountId, date),

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
