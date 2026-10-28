import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  expensesPermissionGrants,
  expensesPermissions,
  filesPermissions,
  identityPermissions,
  masterdataPermissions,
  platformPermissions,
  projectsPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals } from '../approvals/index.js';
import { createFileStore, createFiles, type Files } from '../files/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createProjects, type Projects } from '../projects/index.js';
import { createExpenses, type Expenses } from './index.js';
import type { ClaimInput } from './service/claims.service.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('expenses-test-secret-expenses-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-7777-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const ACCOUNTANT = uid(4);
export const SUPERVISOR = uid(5);
export const SUPERVISOR2 = uid(6);
export const STOREKEEPER = uid(7);
export const NOBODY = uid(8);
export const STOREKEEPER2 = uid(9);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [SUPERVISOR2, 'supervisor2@example.test', 'supervisor'],
  [STOREKEEPER, 'storekeeper@example.test', 'storekeeper'],
  [NOBODY, 'nobody@example.test', 'nopower'],
  [STOREKEEPER2, 'storekeeper2@example.test', 'storekeeper'],
];

export const PDF_BYTES = Uint8Array.from(
  [...'%PDF-1.7 synthetic receipt'].map((c) => c.charCodeAt(0)),
);

export interface ExpensesKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  files: Files;
  projects: Projects;
  expenses: Expenses;
  app: FastifyInstance;
  now: { current: Date };
  /** Cost codes by H-25 code: 100 materials, 200 labour, 500 site expenses. */
  codes: Record<string, string>;
  /** A synthetic cost code that has been switched off. */
  inactiveCode: string;
  /** The project manager, who files claims. */
  actor: Actor;
  /** A caller holding the permissions its role gets from the migration grants. */
  actorFor(userId: string, scopes?: Actor['scopes']): Actor;
  /** An active project. */
  project(): Promise<{ id: string; code: string }>;
  /** Assigns a supervisor to a project, which gives them its project scope. */
  assignSupervisor(projectId: string, userId: string): Promise<void>;
  /** Sets up (or changes) an expense category. */
  category(
    code: string,
    over?: { receiptRequired?: boolean; maxWithoutReceipt?: string },
  ): Promise<void>;
  /** A synthetic client party, for projects. */
  clientId: string;
  /** One line: transport, a distinct amount from 1,001.00, on site expenses (500), dated two days ago. */
  line(over?: Partial<ClaimInput['lines'][number]>): ClaimInput['lines'][number];
  input(over?: Partial<ClaimInput>): ClaimInput;
  /** A draft claim of the user (the project manager by default); returns its id. */
  draft(over?: Partial<ClaimInput>, userId?: string): Promise<string>;
  submit(id: string, userId?: string, acknowledge?: boolean): Promise<void>;
  /** The owner (management) decides the open approval request; the events are delivered. */
  decide(id: string, action: 'approve' | 'reject' | 'return'): Promise<void>;
  /** Delivers every due event. */
  dispatch(): Promise<void>;
  /** Submitted and approved; the cost entries are booked. */
  approved(over?: Partial<ClaimInput>, userId?: string): Promise<string>;
  /** Approved and posted by the accountant. */
  posted(over?: Partial<ClaimInput>, userId?: string): Promise<string>;
  attachReceipt(claimId: string, userId?: string): Promise<string>;
  /** Registers a custodian with a float limit. */
  custodian(userId: string, floatLimit?: string): Promise<void>;
  /** Issues an advance to a custodian (registering them first); returns the advance id. */
  advance(userId: string, amount: string): Promise<string>;
  version(id: string): Promise<number>;
  advanceVersion(id: string): Promise<number>;
  /** The cost ledger rows of the claim's lines, newest chain state per line. */
  entries(
    projectId?: string,
  ): Promise<{ status: string; amount: string; sourceLineId: string | null }[]>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let lineSeq = 0;

export async function createExpensesKit(): Promise<ExpensesKit> {
  const db = await createTestDb();
  const directory = await mkdtemp(path.join(tmpdir(), 'emporium-expenses-'));
  const now = { current: new Date('2026-10-25T10:00:00Z') };
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
  identity.registerPermissions('files', Object.values(filesPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('projects', Object.values(projectsPermissions));
  identity.registerPermissions('expenses', Object.values(expensesPermissions));
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
  const { store } = createFileStore(
    {
      driver: 'local',
      local: {
        directory,
        secret: 'kit-secret-kit-secret-kit',
        baseUrl: 'https://api.example.test',
      },
    },
    clock.now,
  );
  const files = createFiles({ platform, clock, newId, newKey: randomUUID, store });
  const projects = createProjects({
    platform,
    clock,
    newId,
    allowGovernmentData: false,
    masterData,
    identity,
    quotations: { getQuotation: async () => ({}) as never },
    estimation: { getEstimateCostLines: async () => [] as never },
  });
  const expenses = createExpenses({
    platform,
    clock,
    newId,
    projects,
    approvals,
    masterData,
    files,
    identity,
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
    expenses: { db, expenses, platform },
  });
  await app.ready();

  const admin = { userId: ADMIN, requestId: null };
  const client = await db.transaction((tx) =>
    masterData.parties.create(
      { name: 'Synthetic Client', roles: ['client'], city: 'Lahore' },
      admin,
      tx,
    ),
  );
  const seeded = await masterData.costing.listCostCodes(db);
  const codes = Object.fromEntries(seeded.map((code) => [code.code, code.id]));
  const inactive = await db.transaction((tx) =>
    masterData.costing.createCostCode(
      { code: '999', name: 'Retired synthetic code', kind: 'overhead', active: false },
      admin,
      tx,
    ),
  );

  const rolesOf = (userId: string) => USERS.filter(([id]) => id === userId).map(([, , r]) => r);
  const actorFor = (userId: string, scopes: Actor['scopes'] = []): Actor => {
    const roles = rolesOf(userId);
    return {
      userId,
      roles,
      scopes,
      permissions: new Set<string>([
        ...Object.entries(expensesPermissionGrants)
          .filter(([, granted]) => granted.some((role) => roles.includes(role)))
          .map(([permission]) => permission),
        ...Object.values(filesPermissions),
        ...Object.values(projectsPermissions),
      ]),
      requestId: null,
    };
  };
  const actor = actorFor(PM);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  const accountant = actorFor(ACCOUNTANT);

  const kit: ExpensesKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    files,
    projects,
    expenses,
    app,
    now,
    codes,
    clientId: client.id,
    inactiveCode: inactive.id,
    actor,
    actorFor,

    async project() {
      const created = await db.transaction((tx) =>
        projects.service.create(
          {
            name: 'Synthetic boundary wall',
            partyId: client.id,
            sector: 'private',
            originalContractValue: '1000000',
          },
          actor,
          tx,
        ),
      );
      const active = await db.transaction((tx) =>
        projects.service.transition(created.id, 'active', created.version, actor, tx),
      );
      return { id: active.id, code: active.code };
    },

    async assignSupervisor(projectId, userId) {
      await db.transaction((tx) =>
        projects.service.setSupervisors(projectId, [{ userId }], actor, tx),
      );
    },

    async category(code, over = {}) {
      await db.transaction((tx) =>
        expenses.categories.save(
          [
            {
              code,
              name: `Category ${code}`,
              receiptRequired: over.receiptRequired ?? false,
              maxWithoutReceipt: over.maxWithoutReceipt ?? '0',
            },
          ],
          accountant,
          tx,
        ),
      );
    },

    line(over = {}) {
      // Each default line has its own amount, so lines of different tests are not taken for repeats.
      lineSeq += 1;
      return {
        expenseDate: '2026-10-23',
        category: 'transport',
        description: 'Van to site',
        costObjectType: 'overhead',
        costObjectId: null,
        costCodeId: codes['500'] as string,
        amount: `${1000 + lineSeq}.00`,
        ...over,
      };
    },

    input(over = {}) {
      return { note: 'Site visit', lines: [kit.line()], ...over };
    },

    async draft(over = {}, userId = PM) {
      const created = await db.transaction((tx) =>
        expenses.claims.create(kit.input(over), actorFor(userId), tx),
      );
      return created.id;
    },

    async submit(id, userId = PM, acknowledge = false) {
      const version = await kit.version(id);
      await db.transaction((tx) =>
        expenses.claims.submit(
          id,
          { acknowledgeDuplicates: acknowledge },
          version,
          actorFor(userId),
          tx,
        ),
      );
    },

    async decide(id, action) {
      const state = await approvals.getApprovalState(db, 'expense_claim', id);
      if (state.status === 'none') throw new Error('no approval request');
      await db.transaction((tx) =>
        approvals.service.act(
          state.id,
          action,
          { comment: action === 'approve' ? null : 'Not now' },
          { userId: MANAGEMENT, roles: ['management'], scopes: [], requestId: null },
          tx,
        ),
      );
      await kit.dispatch();
    },

    async dispatch() {
      // One dispatch handles at most 50 events, so keep going until nothing is due.
      while ((await platform.events.dispatchDue(db)).dispatched > 0);
    },

    async approved(over = {}, userId = PM) {
      const id = await kit.draft(over, userId);
      await kit.submit(id, userId);
      await kit.decide(id, 'approve');
      return id;
    },

    async posted(over = {}, userId = PM) {
      const id = await kit.approved(over, userId);
      const version = await kit.version(id);
      await db.transaction((tx) => expenses.claims.post(id, version, accountant, tx));
      return id;
    },

    async attachReceipt(claimId, userId = PM) {
      const { attachment } = await db.transaction((tx) =>
        files.attach(
          {
            entityType: 'exp_claim',
            entityId: claimId,
            fileName: 'receipt.pdf',
            bytes: Uint8Array.from([...PDF_BYTES, counter++]),
          },
          actorFor(userId),
          tx,
        ),
      );
      return attachment.id;
    },

    async custodian(userId, floatLimit = '50000') {
      await db.transaction((tx) =>
        expenses.advances.saveCustodian(userId, { floatLimit, active: true }, accountant, tx),
      );
    },

    async advance(userId, amount) {
      await kit.custodian(userId);
      const issued = await db.transaction((tx) =>
        expenses.advances.issue(
          { custodianId: userId, amount, issuedOn: '2026-10-24', purpose: 'Site petty cash' },
          accountant,
          tx,
        ),
      );
      return issued.id;
    },

    async version(id) {
      return (await expenses.claims.get(db, id, accountant)).version;
    },

    async advanceVersion(id) {
      const page = await expenses.advances.list(db, { limit: 200, offset: 0 }, accountant);
      return (page.items.find((a) => a.id === id) as { version: number }).version;
    },

    async entries(projectId) {
      const object =
        projectId === undefined
          ? ({ type: 'overhead', id: null } as const)
          : ({ type: 'project', id: projectId } as const);
      const page = await projects.costing.listEntries(db, object, { limit: 200, offset: 0 });
      return page.items.map((e) => ({
        status: e.status,
        amount: e.amount,
        sourceLineId: e.sourceLineId,
      }));
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
      await rm(directory, { recursive: true, force: true });
    },
  };

  await kit.category('transport');
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
