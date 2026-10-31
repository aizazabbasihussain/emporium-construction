import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  attendancePermissionGrants,
  attendancePermissions,
  identityPermissions,
  importerPermissions,
  masterdataPermissions,
  platformPermissions,
  projectsPermissions,
  wagesPermissionGrants,
  wagesPermissions,
  workerportalPermissionGrants,
  workerportalPermissions,
  workforcePermissionGrants,
  workforcePermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals } from '../approvals/index.js';
import { createAttendance, type Attendance } from '../attendance/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createImporter } from '../importer/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createProjects, type Projects } from '../projects/index.js';
import { createWages, type Wages } from '../wages/index.js';
import { createWorkforce, type Workforce } from '../workforce/index.js';
import { createWorkerPortal, ensureWorkerRole, type WorkerPortal } from './index.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('portal-test-secret-portal-test-secret-portal-test');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-bbbb-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const ACCOUNTANT = uid(4);
export const SUPERVISOR = uid(5);
/** Logins that hold only the worker role. */
export const LOGIN_A = uid(6);
export const LOGIN_B = uid(7);
export const LOGIN_SPARE = uid(8);
/** A login with the worker role and another one. */
export const LOGIN_MIXED = uid(9);
export const NOBODY = uid(10);

const USERS: [string, string, string[]][] = [
  [ADMIN, 'admin@example.test', ['admin']],
  [MANAGEMENT, 'management@example.test', ['management']],
  [PM, 'pm@example.test', ['project_manager']],
  [ACCOUNTANT, 'accountant@example.test', ['accountant']],
  [SUPERVISOR, 'supervisor@example.test', ['supervisor']],
  [LOGIN_A, 'login-a@example.test', ['worker']],
  [LOGIN_B, 'login-b@example.test', ['worker']],
  [LOGIN_SPARE, 'login-spare@example.test', ['worker']],
  [LOGIN_MIXED, 'login-mixed@example.test', ['worker', 'supervisor']],
  [NOBODY, 'nobody@example.test', ['nopower']],
];

/** The clock of every kit: Sunday 25 October 2026, 15:00 in Karachi. */
export const TODAY = '2026-10-25';
/** Friday and Thursday of the week before the clock, inside the backdating allowance. */
export const FRIDAY = '2026-10-23';
export const THURSDAY = '2026-10-22';

export interface Person {
  id: string;
  code: string;
  fullName: string;
}

export interface PortalKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  workforce: Workforce;
  attendance: Attendance;
  wages: Wages;
  workerPortal: WorkerPortal;
  app: FastifyInstance;
  now: { current: Date };
  /** Two synthetic daily-rate workers (1,000 a day) in one team on one project. */
  workerA: Person;
  workerB: Person;
  /** A caller holding the permissions its roles get from the migration grants. */
  actorFor(userId: string): Promise<Actor>;
  /** Links a login to a worker as the admin does. */
  link(workerId: string, userId: string, confirmOtherRoles?: boolean): Promise<void>;
  /** An approved attendance sheet of both workers (present, 2 hours overtime for worker A). */
  approveAttendance(date?: string): Promise<void>;
  /** Calculates the month for everyone, optionally with an advance for worker A. */
  calculate(year?: number, month?: number): Promise<{ id: string; version: number }>;
  /** Submits and has the owner approve the period; the events are delivered. */
  approvePeriod(periodId: string): Promise<void>;
  /** The owner reopens an approved period. */
  reopenPeriod(periodId: string): Promise<void>;
  advance(workerId: string, amount: string, monthlyRecovery: string): Promise<void>;
  dispatch(): Promise<void>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let workerSeq = 0;

export async function createPortalKit(): Promise<PortalKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-bbbb-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('importer', Object.values(importerPermissions));
  identity.registerPermissions('approvals', Object.values(approvalsPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('projects', Object.values(projectsPermissions));
  identity.registerPermissions('workforce', Object.values(workforcePermissions));
  identity.registerPermissions('attendance', Object.values(attendancePermissions));
  identity.registerPermissions('wages', Object.values(wagesPermissions));
  identity.registerPermissions('workerportal', Object.values(workerportalPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  await ensureWorkerRole(identity, db);
  const importer = createImporter({ platform, clock, newId });
  const masterData: MasterData = createMasterData({
    platform,
    clock,
    newId,
    registerImporter: (definition) => importer.registerImporter(definition),
  });
  const approvals: Approvals = createApprovals({
    platform,
    clock,
    newId,
    roleCodes: async (tx) => (await identity.roles.list(tx)).map((role) => role.code),
  });
  const projects: Projects = createProjects({
    platform,
    clock,
    newId,
    allowGovernmentData: false,
    masterData,
    identity,
    quotations: { getQuotation: async () => ({}) as never },
    estimation: { getEstimateCostLines: async () => [] as never },
  });
  const late: { current?: Attendance } = {};
  const lateWages: { current?: Wages } = {};
  const workforce = createWorkforce({
    platform,
    clock,
    newId,
    identity,
    masterData,
    attendance: {
      listUnapprovedSheets: (tx, workerId, upTo) =>
        (late.current as Attendance).listUnapprovedSheets(tx, workerId, upTo),
    },
    registerImporter: (definition) => importer.registerImporter(definition),
  });
  const attendance = createAttendance({
    platform,
    clock,
    newId,
    projects,
    approvals,
    masterData,
    workforce,
    wages: {
      approvedPeriodOf: (tx, date) => (lateWages.current as Wages).approvedPeriodOf(tx, date),
    },
  });
  late.current = attendance;
  const wages = createWages({
    platform,
    clock,
    newId,
    approvals,
    workforce,
    attendance,
    payments: { hasPaidLines: async () => false },
  });
  lateWages.current = wages;
  const workerPortal = createWorkerPortal({
    platform,
    clock,
    identity,
    workforce,
    attendance,
    wages,
  });

  for (const [id, email, roles] of USERS) {
    await db.query(
      `insert into sys_users (id, auth_subject, email, full_name) values ($1, $2, $2, $2)`,
      [id, email],
    );
    for (const role of roles) {
      await db.query('insert into sys_user_roles (user_id, role_code) values ($1, $2)', [id, role]);
    }
  }

  const app = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => now.current,
    identity: { db, identity },
    workerPortal: { db, workerPortal, platform },
  });
  await app.ready();

  const grants = {
    ...attendancePermissionGrants,
    ...workforcePermissionGrants,
    ...wagesPermissionGrants,
    ...workerportalPermissionGrants,
  } as Record<string, readonly string[]>;
  const rolesOf = (userId: string) => USERS.find(([id]) => id === userId)?.[2] as string[];
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  const kitActor = async (userId: string): Promise<Actor> => {
    const roles = rolesOf(userId);
    const user = (await identity.users.list(db)).find((candidate) => candidate.id === userId);
    return {
      userId,
      roles,
      scopes: user?.scopes ?? [],
      permissions: new Set<string>([
        ...Object.entries(grants)
          .filter(([, granted]) => granted.some((role) => roles.includes(role)))
          .map(([permission]) => permission),
        ...Object.values(projectsPermissions),
      ]),
      requestId: null,
    };
  };

  const admin = { userId: ADMIN, requestId: null };
  const client = await db.transaction((tx) =>
    masterData.parties.create(
      { name: 'Synthetic Client', roles: ['client'], city: 'Lahore' },
      admin,
      tx,
    ),
  );

  const makeWorker = async (): Promise<Person> => {
    workerSeq += 1;
    const actor = await kitActor(MANAGEMENT);
    const worker = await db.transaction((tx) =>
      workforce.workers.create(
        {
          fullName: `Synthetic Worker ${workerSeq}`,
          cnic: String(3520100000000 + workerSeq),
          tradeCode: 'mason',
          employmentType: 'daily',
          joinedOn: '2026-01-01',
        },
        actor,
        tx,
      ),
    );
    const accountant = await kitActor(ACCOUNTANT);
    await db.transaction((tx) =>
      workforce.workers.addRate(
        worker.id,
        { payBasis: 'daily_rate', amount: '1000', effectiveFrom: '2026-01-01' },
        accountant,
        tx,
      ),
    );
    return { id: worker.id, code: worker.code, fullName: worker.fullName };
  };

  const pm = await kitActor(PM);
  const projectDraft = await db.transaction((tx) =>
    projects.service.create(
      {
        name: 'Synthetic boundary wall',
        partyId: client.id,
        sector: 'private',
        originalContractValue: '1000000',
      },
      pm,
      tx,
    ),
  );
  const project = await db.transaction((tx) =>
    projects.service.transition(projectDraft.id, 'active', projectDraft.version, pm, tx),
  );
  await db.transaction((tx) =>
    projects.service.setSupervisors(project.id, [{ userId: SUPERVISOR }], pm, tx),
  );
  const management = await kitActor(MANAGEMENT);
  const team = await db.transaction((tx) =>
    workforce.teams.create(
      { name: 'Synthetic team', supervisorUserId: SUPERVISOR },
      management,
      tx,
    ),
  );
  const workerA = await makeWorker();
  const workerB = await makeWorker();
  const teamNow = await workforce.getTeam(db, team.id, management);
  await db.transaction((tx) =>
    workforce.teams.setMembers(
      team.id,
      { workerIds: [workerA.id, workerB.id], date: '2026-01-01' },
      teamNow.version,
      management,
      tx,
    ),
  );

  const kit: PortalKit = {
    db,
    platform,
    identity,
    workforce,
    attendance,
    wages,
    workerPortal,
    app,
    now,
    workerA,
    workerB,
    actorFor: kitActor,

    async link(workerId, userId, confirmOtherRoles = false) {
      const actor = await kitActor(ADMIN);
      await db.transaction((tx) =>
        workerPortal.accounts.link(workerId, { userId, confirmOtherRoles }, actor, tx),
      );
    },

    async approveAttendance(date = FRIDAY) {
      const supervisor = await kitActor(SUPERVISOR);
      const saved = await db.transaction((tx) =>
        attendance.sheets.save(
          team.id,
          date,
          {
            entries: [
              {
                workerId: workerA.id,
                status: 'present' as const,
                overtimeHours: '2',
                allocations: [{ projectId: project.id, fraction: '1' }],
              },
              {
                workerId: workerB.id,
                status: 'present' as const,
                allocations: [{ projectId: project.id, fraction: '1' }],
              },
            ],
          },
          supervisor,
          tx,
        ),
      );
      const accountant = await kitActor(ACCOUNTANT);
      const current = await attendance.sheets.get(db, saved.id, accountant);
      await db.transaction((tx) =>
        attendance.sheets.submit(saved.id, current.version, supervisor, tx),
      );
      const state = await approvals.getApprovalState(db, 'attendance_sheet', saved.id);
      if (state.status === 'none') throw new Error('no approval request');
      await db.transaction((tx) =>
        approvals.service.act(
          state.id,
          'approve',
          { comment: null },
          { userId: PM, roles: ['project_manager'], scopes: [], requestId: null },
          tx,
        ),
      );
      await kit.dispatch();
    },

    async calculate(year = 2026, month = 10) {
      const actor = await kitActor(ACCOUNTANT);
      const period = await db.transaction((tx) => wages.periods.create({ year, month }, actor, tx));
      await db.transaction((tx) => wages.periods.calculate(period.id, actor, tx));
      const detail = await wages.periods.get(db, period.id);
      return { id: period.id, version: detail.version };
    },

    async approvePeriod(periodId) {
      const actor = await kitActor(ACCOUNTANT);
      const current = await wages.periods.get(db, periodId);
      await db.transaction((tx) =>
        wages.periods.submit(
          periodId,
          { version: current.version, acknowledgeWarnings: true },
          actor,
          tx,
        ),
      );
      const state = await approvals.getApprovalState(db, 'wage_period', periodId);
      if (state.status === 'none') throw new Error('no approval request');
      await db.transaction((tx) =>
        approvals.service.act(
          state.id,
          'approve',
          { comment: null },
          { userId: MANAGEMENT, roles: ['management'], scopes: [], requestId: null },
          tx,
        ),
      );
      await kit.dispatch();
    },

    async reopenPeriod(periodId) {
      const actor = await kitActor(MANAGEMENT);
      const current = await wages.periods.get(db, periodId);
      await db.transaction((tx) =>
        wages.periods.reopen(
          periodId,
          { version: current.version, reason: 'Check the figures' },
          actor,
          tx,
        ),
      );
    },

    async advance(workerId, amount, monthlyRecovery) {
      const actor = await kitActor(ACCOUNTANT);
      await db.transaction((tx) =>
        wages.advances.create(
          { workerId, amount, monthlyRecovery, issuedOn: '2026-09-15' },
          actor,
          tx,
        ),
      );
    },

    async dispatch() {
      while ((await platform.events.dispatchDue(db)).dispatched > 0);
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
