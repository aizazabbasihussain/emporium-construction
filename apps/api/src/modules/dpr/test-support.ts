import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type SqlDb } from '@emporium/db';
import {
  dprPermissionGrants,
  dprPermissions,
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
import { createFileStore, createFiles, type Files } from '../files/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createNotifications, type Notifications } from '../notifications/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createProjects, type Projects } from '../projects/index.js';
import { createDpr, type Dpr } from './index.js';
import type { CreateReportInput, ReportFields } from './service/reports.service.js';
import type { Actor, ReportDto } from './types.js';

const SECRET = new TextEncoder().encode('dpr-test-secret-dpr-test-secret-dpr');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-8888-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const ACCOUNTANT = uid(4);
export const SUPERVISOR = uid(5);
export const SUPERVISOR2 = uid(6);
export const NOBODY = uid(7);
export const PM2 = uid(8);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [SUPERVISOR2, 'supervisor2@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
  [PM2, 'pm2@example.test', 'project_manager'],
];

/** A JPEG signature is enough for the file type check; the counter keeps photos distinct. */
export const photoBytes = (n: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, n]);

export interface DprKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  files: Files;
  projects: Projects;
  notifications: Notifications;
  dpr: Dpr;
  app: FastifyInstance;
  now: { current: Date };
  /** A caller holding the permissions its role gets from the migration grants. */
  actorFor(userId: string, scopes?: Actor['scopes']): Actor;
  /** An active project managed by PM. */
  project(
    over?: { projectManagerId?: string | null },
    activate?: boolean,
  ): Promise<{ id: string; code: string }>;
  /** Assigns a supervisor to a project (which gives them its project scope); returns their actor. */
  assign(projectId: string, userId: string): Promise<Actor>;
  task(projectId: string, name: string, percent?: number): Promise<{ id: string }>;
  /** Valid fields for a draft: weather, work done long enough, one manpower line. */
  fields(over?: ReportFields): ReportFields;
  input(projectId: string, over?: Partial<CreateReportInput>): CreateReportInput;
  /** A draft report of the user (the supervisor by default); the project must be assigned. */
  draft(
    projectId: string,
    over?: Partial<CreateReportInput>,
    userId?: string,
    scopes?: Actor['scopes'],
  ): Promise<ReportDto>;
  photo(reportId: string, userId?: string, scopes?: Actor['scopes']): Promise<string>;
  /** A draft with a photo, submitted. */
  submitted(
    projectId: string,
    over?: Partial<CreateReportInput>,
    userId?: string,
  ): Promise<ReportDto>;
  setSetting(key: string, value: unknown): Promise<void>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let photoSeq = 0;
let projectSeq = 0;

export async function createDprKit(): Promise<DprKit> {
  const db = await createTestDb();
  const directory = await mkdtemp(path.join(tmpdir(), 'emporium-dpr-'));
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-8888-7000-8000-${String(++counter).padStart(12, '0')}`;
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
  identity.registerPermissions('dpr', Object.values(dprPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  const masterData: MasterData = createMasterData({
    platform,
    clock,
    newId,
    registerImporter: () => undefined,
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
    directory: {
      async usersWithRole(tx, roleCode) {
        return (await identity.users.list(tx))
          .filter((user) => user.status === 'active' && user.roles.includes(roleCode))
          .map((user) => ({ id: user.id, roles: user.roles, scopes: user.scopes }));
      },
    },
    getApprovalState: () => Promise.reject(new Error('no approvals in this kit')),
  });
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
  const dpr = createDpr({ platform, clock, newId, projects, files, notifications });

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
    files: { db, files, platform, local: undefined },
    dpr: { db, dpr, platform },
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

  const rolesOf = (userId: string) => USERS.filter(([id]) => id === userId).map(([, , r]) => r);
  const actorFor = (userId: string, scopes: Actor['scopes'] = []): Actor => {
    const roles = rolesOf(userId);
    return {
      userId,
      roles,
      scopes,
      permissions: new Set<string>([
        ...Object.entries(dprPermissionGrants)
          .filter(([, granted]) => granted.some((role) => roles.includes(role)))
          .map(([permission]) => permission),
        ...Object.values(filesPermissions),
        ...Object.values(projectsPermissions),
      ]),
      requestId: null,
    };
  };
  const pm = actorFor(PM);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;

  const kit: DprKit = {
    db,
    platform,
    identity,
    files,
    projects,
    notifications,
    dpr,
    app,
    now,
    actorFor,

    async project(over = {}, activate = true) {
      projectSeq += 1;
      const created = await db.transaction((tx) =>
        projects.service.create(
          {
            name: `Synthetic boundary wall ${projectSeq}`,
            partyId: client.id,
            sector: 'private',
            originalContractValue: '1000000',
            projectManagerId: PM,
            ...over,
          },
          pm,
          tx,
        ),
      );
      if (!activate) return { id: created.id, code: created.code };
      const active = await db.transaction((tx) =>
        projects.service.transition(created.id, 'active', created.version, pm, tx),
      );
      return { id: active.id, code: active.code };
    },

    async assign(projectId, userId) {
      const current = (await projects.service.get(db, projectId, pm)).supervisors.map((s) => ({
        userId: s.userId,
      }));
      await db.transaction((tx) =>
        projects.service.setSupervisors(
          projectId,
          [...current.filter((s) => s.userId !== userId), { userId }],
          pm,
          tx,
        ),
      );
      return actorFor(userId, [{ type: 'project', id: projectId }]);
    },

    async task(projectId, name, percent = 0) {
      return db.transaction((tx) =>
        projects.service.createTask(projectId, { name, percentComplete: percent }, pm, tx),
      );
    },

    fields(over = {}) {
      return {
        weather: 'clear',
        workDone: 'Poured the first lift of the roof slab',
        issues: 'Cement delivery was late',
        safetyNotes: 'Toolbox talk held',
        manpowerManual: [{ trade: 'Mason', count: 4 }],
        ...over,
      };
    },

    input(projectId, over = {}) {
      return { projectId, reportDate: '2026-10-24', ...kit.fields(), ...over };
    },

    async draft(projectId, over = {}, userId = SUPERVISOR, scopes) {
      const actor = actorFor(userId, scopes ?? [{ type: 'project', id: projectId }]);
      return db.transaction((tx) => dpr.reports.create(kit.input(projectId, over), actor, tx));
    },

    async photo(reportId, userId = SUPERVISOR, scopes = []) {
      photoSeq += 1;
      const { attachment } = await db.transaction((tx) =>
        files.attach(
          {
            entityType: 'dpr_report',
            entityId: reportId,
            fileName: `site-${photoSeq}.jpg`,
            bytes: photoBytes(photoSeq % 250),
            caption: 'North wall',
          },
          actorFor(userId, scopes),
          tx,
        ),
      );
      return attachment.id;
    },

    async submitted(projectId, over = {}, userId = SUPERVISOR) {
      const scopes = [{ type: 'project' as const, id: projectId }];
      const report = await kit.draft(projectId, over, userId, scopes);
      await kit.photo(report.id, userId, scopes);
      return db.transaction((tx) =>
        dpr.reports.submit(report.id, report.version, actorFor(userId, scopes), tx),
      );
    },

    async setSetting(key, value) {
      const current = await platform.settings.get(db, key);
      await db.transaction((tx) =>
        platform.settings.set(
          { key, value, expectedVersion: current.version },
          { actorUserId: ADMIN, requestId: null },
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
