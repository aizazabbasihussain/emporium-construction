import { createTestDb, type SqlDb } from '@emporium/db';
import {
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
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createProjects, type Projects, type PostCostInput } from './index.js';
import type { Actor, ProjectDetailDto } from './types.js';

const SECRET = new TextEncoder().encode('projects-test-secret-projects-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-5555-7000-8000-${String(n).padStart(12, '0')}`;

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

const ROLES: Record<string, string[]> = Object.fromEntries(
  USERS.map(([id, , role]) => [id, [role]]),
);

export interface EstimateLineStub {
  costCodeId: string;
  amount: string;
}

export interface ProjectsKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  projects: Projects;
  app: FastifyInstance;
  now: { current: Date };
  /** Cost codes by H-25 code: 100 materials, 200 labour, 300 subcontractors, 500 site expenses. */
  codes: Record<string, string>;
  /** A synthetic cost code that has been switched off. */
  inactiveCode: string;
  clientId: string;
  locationId: string;
  /** What the estimate stub returns for an estimate id. */
  estimates: Map<string, EstimateLineStub[]>;
  actorFor(userId: string, scopes?: Actor['scopes']): Actor;
  /** A manual project made by the project manager. */
  project(over?: Partial<Parameters<Projects['service']['create']>[0]>): Promise<ProjectDetailDto>;
  /** A project moved on to `active`. */
  activeProject(): Promise<ProjectDetailDto>;
  /** Posts a cost to a project (committed, 100.00 on materials unless overridden). */
  cost(projectId: string | null, over?: Partial<PostCostInput>): Promise<string>;
  /** Publishes `quotation.accepted` and delivers it. */
  accept(over?: Partial<AcceptedEvent>): Promise<AcceptedEvent>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

export interface AcceptedEvent {
  quotationId: string;
  estimateId: string;
  partyId: string;
  sector: 'private' | 'government';
  locationId: string | null;
  contractValue: string;
}

let counter = 0;

export async function createProjectsKit(
  options: { allowGovernmentData?: boolean } = {},
): Promise<ProjectsKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-5555-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('files', Object.values(filesPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('projects', Object.values(projectsPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  const masterData = createMasterData({
    platform,
    clock,
    newId,
    registerImporter: () => undefined,
  });
  const estimates = new Map<string, EstimateLineStub[]>();
  let quotationSeq = 0;
  const projects = createProjects({
    platform,
    clock,
    newId,
    allowGovernmentData: options.allowGovernmentData ?? false,
    masterData,
    identity,
    quotations: {
      getQuotation: async (_db, id) => ({ id, title: `Synthetic job ${id.slice(-4)}` }) as never,
    },
    estimation: {
      getEstimateCostLines: async (_db, id) =>
        (estimates.get(id) ?? []).map((line, index) => ({
          lineNo: index + 1,
          description: 'Synthetic line',
          lineKind: 'material',
          itemId: null,
          unitCode: 'nos',
          quantity: '1',
          rate: line.amount,
          ...line,
        })) as never,
    },
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
    projects: { db, projects, platform },
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
  const location = await db.transaction((tx) =>
    masterData.company.createLocation(
      { name: 'F-10', region: 'islamabad', city: 'Islamabad' },
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

  const allPermissions = new Set<string>(Object.values(projectsPermissions));
  const actorFor = (userId: string, scopes: Actor['scopes'] = []): Actor => ({
    userId,
    roles: ROLES[userId] ?? [],
    scopes,
    permissions: allPermissions,
    requestId: null,
  });
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;

  const kit: ProjectsKit = {
    db,
    platform,
    identity,
    masterData,
    projects,
    app,
    now,
    codes,
    inactiveCode: inactive.id,
    clientId: client.id,
    locationId: location.id,
    estimates,
    actorFor,

    project(over = {}) {
      return db.transaction((tx) =>
        projects.service.create(
          {
            name: 'Synthetic boundary wall',
            partyId: client.id,
            sector: 'private',
            originalContractValue: '1000000',
            ...over,
          },
          actorFor(PM),
          tx,
        ),
      );
    },

    async activeProject() {
      const created = await kit.project();
      return db.transaction((tx) =>
        projects.service.transition(created.id, 'active', created.version, actorFor(PM), tx),
      );
    },

    async cost(projectId, over = {}) {
      quotationSeq += 1;
      const entry = await db.transaction((tx) =>
        projects.postCost(
          {
            costObject:
              projectId === null
                ? { type: 'overhead', id: null }
                : { type: 'project', id: projectId },
            costCodeId: codes['100'] as string,
            amount: '100.00',
            status: 'committed',
            sourceModule: 'procurement',
            sourceDocType: 'purchase_order',
            sourceDocId: uid(1000 + quotationSeq),
            sourceLineId: uid(2000 + quotationSeq),
            entryDate: '2026-10-25',
            idempotencyKey: `kit-${quotationSeq}`,
            ...over,
          },
          tx,
        ),
      );
      return entry.id;
    },

    async accept(over = {}) {
      quotationSeq += 1;
      const event: AcceptedEvent = {
        quotationId: uid(3000 + quotationSeq),
        estimateId: uid(4000 + quotationSeq),
        partyId: client.id,
        sector: 'private',
        locationId: location.id,
        contractValue: '2000000.00',
        ...over,
      };
      await db.transaction((tx) =>
        platform.events.publish({ type: 'quotation.accepted', payload: event }, tx),
      );
      await platform.events.dispatchDue(db);
      return event;
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
