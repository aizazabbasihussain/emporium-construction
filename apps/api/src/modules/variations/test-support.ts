import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  filesPermissions,
  identityPermissions,
  masterdataPermissions,
  platformPermissions,
  projectsPermissions,
  variationsPermissions,
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
import { createProjects, type PostCostInput, type Projects } from '../projects/index.js';
import { createVariations, type Variations } from './index.js';
import type { VariationInput } from './service/variations.service.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('variations-test-secret-variations-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-6666-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const ACCOUNTANT = uid(4);
export const SUPERVISOR = uid(5);
export const SUPERVISOR2 = uid(6);
export const NOBODY = uid(7);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [SUPERVISOR2, 'supervisor2@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

export const PDF_BYTES = Uint8Array.from(
  [...'%PDF-1.7 client approval letter'].map((c) => c.charCodeAt(0)),
);

export interface VariationsKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  files: Files;
  projects: Projects;
  variations: Variations;
  app: FastifyInstance;
  now: { current: Date };
  /** Cost codes by H-25 code: 100 materials, 200 labour, 300 subcontractors, 500 site expenses. */
  codes: Record<string, string>;
  /** A synthetic cost code that has been switched off. */
  inactiveCode: string;
  /** The project manager, who creates and submits; holds every variations permission. */
  actor: Actor;
  /** Someone else with every variations permission, or with a project scope. */
  actorFor(userId: string, scopes?: Actor['scopes']): Actor;
  /** An active project with an original contract value of 1,000,000.00. */
  project(): Promise<{ id: string; code: string }>;
  /** Assigns a supervisor to a project, which gives them its project scope. */
  assignSupervisor(projectId: string, userId: string): Promise<void>;
  /** The standard input: one line, cost 100.00 and price 150.00 on materials. */
  input(over?: Partial<VariationInput>): VariationInput;
  /** A draft variation of the project, made by the project manager. */
  draft(projectId: string, over?: Partial<VariationInput>): Promise<string>;
  /** Submitted for internal approval and approved by management; the events are delivered. */
  internallyApproved(id: string): Promise<void>;
  /** Internally approved and sent to the client. */
  sent(id: string): Promise<void>;
  attachClientDocument(id: string): Promise<void>;
  /** The full path to client approval, with the document attached. */
  approved(id: string, approvedOn?: string): Promise<void>;
  decide(id: string, action: 'approve' | 'reject' | 'return'): Promise<void>;
  /** Posts an approved or posted cost to a project (posted, 500.00 on materials by default). */
  cost(projectId: string, over?: Partial<PostCostInput>): Promise<string>;
  version(id: string): Promise<number>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;

export async function createVariationsKit(
  options: { ledgerPageSize?: number } = {},
): Promise<VariationsKit> {
  const db = await createTestDb();
  const directory = await mkdtemp(path.join(tmpdir(), 'emporium-variations-'));
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-6666-7000-8000-${String(++counter).padStart(12, '0')}`;
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
  identity.registerPermissions('variations', Object.values(variationsPermissions));
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
  const variations = createVariations({
    platform,
    clock,
    newId,
    projects,
    approvals,
    masterData,
    files,
    ...(options.ledgerPageSize === undefined ? {} : { ledgerPageSize: options.ledgerPageSize }),
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
    variations: { db, variations, platform },
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

  const allPermissions = new Set<string>([
    ...Object.values(variationsPermissions),
    ...Object.values(projectsPermissions),
    ...Object.values(filesPermissions),
  ]);
  const actorFor = (userId: string, scopes: Actor['scopes'] = []): Actor => ({
    userId,
    roles: USERS.filter(([id]) => id === userId).map(([, , role]) => role),
    scopes,
    permissions: allPermissions,
    requestId: null,
  });
  const actor = actorFor(PM);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  let costSeq = 0;

  const kit: VariationsKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    files,
    projects,
    variations,
    app,
    now,
    codes,
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

    input(over = {}) {
      return {
        title: 'Extra excavation',
        reason: 'Rock found below the foundation',
        discoveredOn: '2026-10-20',
        lines: [
          {
            description: 'Rock breaking',
            costCodeId: codes['100'] as string,
            costAmount: '100.00',
            priceAmount: '150.00',
          },
        ],
        ...over,
      };
    },

    async draft(projectId, over = {}) {
      const created = await db.transaction((tx) =>
        variations.service.create(projectId, kit.input(over), actor, tx),
      );
      return created.id;
    },

    async decide(id, action) {
      const state = await approvals.getApprovalState(db, 'variation', id);
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
      await platform.events.dispatchDue(db);
    },

    async internallyApproved(id) {
      const version = await kit.version(id);
      await db.transaction((tx) => variations.service.submitInternal(id, version, actor, tx));
      await kit.decide(id, 'approve');
    },

    async sent(id) {
      await kit.internallyApproved(id);
      const version = await kit.version(id);
      await db.transaction((tx) => variations.service.sendToClient(id, version, actor, tx));
    },

    async attachClientDocument(id) {
      await db.transaction((tx) =>
        files.attach(
          {
            entityType: 'var_variation',
            entityId: id,
            fileName: 'client-letter.pdf',
            bytes: PDF_BYTES,
          },
          actor,
          tx,
        ),
      );
    },

    async approved(id, approvedOn = '2026-10-24') {
      await kit.sent(id);
      await kit.attachClientDocument(id);
      const version = await kit.version(id);
      await db.transaction((tx) =>
        variations.service.clientApprove(
          id,
          { reference: 'CLIENT-LTR-1', approvedOn },
          version,
          actor,
          tx,
        ),
      );
    },

    async cost(projectId, over = {}) {
      costSeq += 1;
      const entry = await db.transaction((tx) =>
        projects.postCost(
          {
            costObject: { type: 'project', id: projectId },
            costCodeId: codes['100'] as string,
            amount: '500.00',
            status: 'posted',
            sourceModule: 'procurement',
            sourceDocType: 'goods_receipt',
            sourceDocId: uid(1000 + costSeq),
            sourceLineId: uid(2000 + costSeq),
            entryDate: '2026-10-22',
            idempotencyKey: `variations-kit-${costSeq}`,
            ...over,
          },
          tx,
        ),
      );
      return entry.id;
    },

    async version(id) {
      return (await variations.service.get(db, id, actor)).version;
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
