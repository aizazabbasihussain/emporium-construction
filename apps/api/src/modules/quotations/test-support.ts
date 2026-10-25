import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  crmPermissions,
  estimationPermissions,
  filesPermissions,
  identityPermissions,
  masterdataPermissions,
  platformPermissions,
  quotationsPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals } from '../approvals/index.js';
import { createCrm, type Crm } from '../crm/index.js';
import { createEstimation, type Estimation } from '../estimation/index.js';
import { createFileStore, createFiles, type Files } from '../files/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createNotifications } from '../notifications/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createQuotations, type Quotations } from './index.js';
import type { CreateQuotationInput } from './service/quotations.service.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('quotations-test-secret-quotations-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-4444-7000-8000-${String(n).padStart(12, '0')}`;

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

const ROLES: Record<string, string[]> = {
  [ADMIN]: ['admin'],
  [MANAGEMENT]: ['management'],
  [PM]: ['project_manager'],
  [ACCOUNTANT]: ['accountant'],
  [SUPERVISOR]: ['supervisor'],
  [NOBODY]: ['nopower'],
};

export const PDF_BYTES = Uint8Array.from(
  [...'%PDF-1.7 signed acceptance'].map((c) => c.charCodeAt(0)),
);

export interface LockedEstimate {
  id: string;
  /** Total cost of the estimate (no overhead or contingency, so it equals the line cost). */
  totalCost: string;
}

export interface QuotationsKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  estimation: Estimation;
  crm: Crm;
  files: Files;
  quotations: Quotations;
  app: FastifyInstance;
  now: { current: Date };
  /** The project manager, who creates and submits. */
  actor: Actor;
  /** Someone else who holds every quotation permission. */
  actorFor(userId: string): Actor;
  clientId: string;
  locationId: string;
  /** A locked estimate costing exactly `cost` and proposing `price`; all synthetic. */
  lockedEstimate(options?: {
    cost?: string;
    price?: string | null;
    sector?: 'private' | 'government';
    partyId?: string | null;
    leadId?: string | null;
  }): Promise<LockedEstimate>;
  /** A draft quotation from a new locked estimate (cost 1000, price 1200). */
  draft(over?: Partial<CreateQuotationInput>, estimate?: LockedEstimate): Promise<string>;
  /** Submits as the project manager, approves as management and delivers the events. */
  approved(id: string): Promise<void>;
  /** Draft to issued. */
  issued(id: string): Promise<void>;
  decide(id: string, action: 'approve' | 'reject' | 'return'): Promise<void>;
  newLead(): Promise<string>;
  attachAcceptance(id: string): Promise<void>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;

export async function createQuotationsKit(): Promise<QuotationsKit> {
  const db = await createTestDb();
  const directory = await mkdtemp(path.join(tmpdir(), 'emporium-quotations-'));
  const now = { current: new Date('2026-10-25T10:00:00Z') };
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
  identity.registerPermissions('files', Object.values(filesPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('crm', Object.values(crmPermissions));
  identity.registerPermissions('estimation', Object.values(estimationPermissions));
  identity.registerPermissions('quotations', Object.values(quotationsPermissions));
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
  const notifications = createNotifications({
    platform,
    clock,
    newId,
    directory: { usersWithRole: async () => [] },
    getApprovalState: approvals.getApprovalState,
  });
  const crm = createCrm({ platform, clock, newId, masterData, notifications, files });
  const estimation = createEstimation({ platform, clock, newId, masterData });
  const quotations = createQuotations({
    platform,
    clock,
    newId,
    estimation,
    approvals,
    crm,
    masterData,
    files,
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
    quotations: { db, quotations, platform },
  });
  await app.ready();

  const allPermissions = new Set<string>([
    ...Object.values(quotationsPermissions),
    ...Object.values(filesPermissions),
  ]);
  const actorFor = (userId: string): Actor => ({
    userId,
    roles: ROLES[userId] ?? [],
    scopes: [],
    permissions: allPermissions,
    requestId: null,
  });
  const actor = actorFor(PM);
  const estimationActor = { userId: ADMIN, requestId: null };

  const client = await db.transaction((tx) =>
    masterData.parties.create(
      { name: 'Synthetic Client', roles: ['client'], city: 'Lahore' },
      estimationActor,
      tx,
    ),
  );
  const location = await db.transaction((tx) =>
    masterData.company.createLocation(
      { name: 'F-10', region: 'islamabad', city: 'Islamabad' },
      estimationActor,
      tx,
    ),
  );
  const company = await db.transaction((tx) =>
    masterData.company.saveCompany(
      { name: 'Synthetic Construction', address: 'Islamabad', phone: '051-1234567' },
      undefined,
      estimationActor,
      tx,
    ),
  );
  void company;
  await db.transaction((tx) =>
    masterData.company.createRegistration(
      {
        authority: 'fbr',
        registrationType: 'ntn',
        number: 'SYNTHETIC-0001',
        validFrom: '2025-01-01',
      },
      estimationActor,
      tx,
    ),
  );

  const codes = await masterData.costing.listCostCodes(db);
  const materialCode = (codes.find((c) => c.kind === 'material') as { id: string }).id;
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;

  const kit: QuotationsKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    estimation,
    crm,
    files,
    quotations,
    app,
    now,
    actor,
    actorFor,
    clientId: client.id,
    locationId: location.id,

    async lockedEstimate(options = {}) {
      const cost = options.cost ?? '1000';
      const price = options.price === undefined ? '1200.00' : options.price;
      const created = await db.transaction((tx) =>
        estimation.estimates.create(
          {
            title: 'Synthetic wall',
            workType: 'boundary_wall',
            sector: options.sector ?? 'private',
            partyId: options.partyId === undefined ? client.id : options.partyId,
            leadId: options.leadId ?? null,
            overheadPercent: '0',
            contingencyPercent: '0',
            targetMarginPercent: '10',
            proposedPrice: price,
            lines: [
              {
                description: 'Bricks',
                lineKind: 'material',
                costCodeId: materialCode,
                unitCode: 'nos',
                quantity: '1',
                rate: cost,
              },
            ],
          },
          estimationActor,
          tx,
        ),
      );
      const locked = await db.transaction((tx) =>
        estimation.estimates.lock(created.id, created.version, estimationActor, tx),
      );
      return { id: locked.id, totalCost: Number(cost).toFixed(2) };
    },

    async draft(over = {}, estimate) {
      const source = estimate ?? (await kit.lockedEstimate());
      const created = await db.transaction((tx) =>
        quotations.service.create(
          {
            estimateId: source.id,
            scopeText: 'Build a boundary wall',
            inclusions: 'Materials and labour',
            exclusions: 'Painting',
            terms: 'Payment within 7 days',
            stages: [
              { name: 'Advance', basis: 'percent', percent: '30', conditionText: 'On signing' },
              { name: 'Completion', basis: 'percent', percent: '70' },
            ],
            ...over,
          },
          actor,
          tx,
          true,
        ),
      );
      return created.id;
    },

    async decide(id, action) {
      const state = await approvals.getApprovalState(db, 'quotation', id);
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

    async approved(id) {
      const row = await quotations.service.get(db, id, false);
      await db.transaction((tx) => quotations.service.submit(id, row.version, actor, tx, false));
      await kit.decide(id, 'approve');
    },

    async issued(id) {
      await kit.approved(id);
      const row = await quotations.service.get(db, id, false);
      await db.transaction((tx) =>
        quotations.service.issue(id, row.version, actorFor(MANAGEMENT), tx, false),
      );
    },

    async newLead() {
      const lead = await db.transaction((tx) =>
        crm.service.createLead(
          { workType: 'new_build', sector: 'private', sourceCode: 'referral', partyId: client.id },
          estimationActor,
          tx,
        ),
      );
      return lead.id;
    },

    async attachAcceptance(id) {
      await db.transaction((tx) =>
        files.attach(
          { entityType: 'qte_quotation', entityId: id, fileName: 'accepted.pdf', bytes: PDF_BYTES },
          actorFor(PM),
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
