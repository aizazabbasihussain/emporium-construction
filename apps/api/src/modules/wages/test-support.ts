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
import { createWorkforce, type Workforce } from '../workforce/index.js';
import { createWages, type Wages, type WagesDeps } from './index.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('wages-test-secret-wages-test-secret-wages-test');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-aaaa-7000-8000-${String(n).padStart(12, '0')}`;

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

/** The clock of every kit: Sunday 25 October 2026, 15:00 in Karachi. */
export const TODAY = '2026-10-25';
/** A Friday inside the 3-day backdating allowance. */
export const FRIDAY = '2026-10-23';
/** The Thursday before it: still inside the allowance (3 days back). */
export const THURSDAY = '2026-10-22';

export interface Setup {
  projectA: string;
  projectB: string;
  teamId: string;
  workerA: { id: string; code: string; fullName: string };
  workerB: { id: string; code: string; fullName: string };
}

type SheetInput = Parameters<Attendance['sheets']['save']>[2];
type SheetDto = Awaited<ReturnType<Attendance['sheets']['save']>>;

export interface WagesKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  projects: Projects;
  workforce: Workforce;
  attendance: Attendance;
  wages: Wages;
  app: FastifyInstance;
  now: { current: Date };
  /** What `payments.hasPaidLines` reports (payment is P2-07). */
  paid: { any: boolean };
  /** An accountant's request to create and calculate the wage period of a month. */
  calculated(year?: number, month?: number): Promise<{ id: string; version: number }>;
  /** Submits (acknowledging warnings) and has the owner approve; the events are delivered. */
  approvePeriod(periodId: string): Promise<void>;
  /** The owner approves the open request of a submitted period; the events are delivered. */
  wagesDecide(periodId: string): Promise<void>;
  /** A simple advance for the worker, issued on a date before the period. */
  advance(
    workerId: string,
    amount: string,
    monthlyRecovery: string,
    issuedOn?: string,
  ): Promise<{ id: string; version: number }>;
  /** Cost codes by H-25 code (100 materials, 200 labour, 500 site expenses). */
  codes: Record<string, string>;
  /** A caller holding the permissions its role gets from the migration grants. */
  actorFor(userId: string): Promise<Actor>;
  /** An active project the supervisor is assigned to. */
  project(supervisorId?: string | null): Promise<string>;
  /** A synthetic worker (daily rate 1,000 from 1 January 2026 unless told otherwise). */
  worker(over?: {
    payBasis?: 'daily_rate' | 'monthly_salary';
    amount?: string | null;
    joinedOn?: string;
  }): Promise<{ id: string; code: string; fullName: string }>;
  team(supervisorId?: string): Promise<{ id: string; version: number }>;
  /** Makes the workers the members of the team from the date. */
  members(teamId: string, workerIds: string[], date?: string): Promise<void>;
  /** Two projects, a team of the supervisor and two workers (daily rate 1,000). */
  setup(): Promise<Setup>;
  /** A sheet body: both workers present on project A (full day) unless told otherwise. */
  body(setup: Setup, over?: Partial<SheetInput>): SheetInput;
  save(
    setup: Pick<Setup, 'teamId'>,
    date: string,
    input: SheetInput,
    userId?: string,
  ): Promise<SheetDto>;
  submit(sheetId: string, userId?: string): Promise<SheetDto>;
  /** The project manager decides the open request; the events are delivered. */
  decide(sheetId: string, action: 'approve' | 'reject' | 'return'): Promise<void>;
  dispatch(): Promise<void>;
  /** Saved, submitted and approved. */
  approved(setup: Setup, date?: string, input?: SheetInput): Promise<SheetDto>;
  get(sheetId: string, userId?: string): Promise<SheetDto>;
  /** The cost ledger rows of a project: newest chain state per line. */
  entries(projectId: string): Promise<
    {
      status: string;
      amount: string;
      sourceLineId: string | null;
      costCodeId: string;
      entryDate: string;
    }[]
  >;
  setSetting(key: string, value: unknown): Promise<void>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let workerSeq = 0;
let cnicSeq = 0;
let teamSeq = 0;

export async function createWagesKit(
  override: {
    workforce?: (real: Workforce) => WagesDeps['workforce'];
    attendance?: (real: Attendance) => WagesDeps['attendance'];
  } = {},
): Promise<WagesKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-aaaa-7000-8000-${String(++counter).padStart(12, '0')}`;
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
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);
  const importer = createImporter({ platform, clock, newId });
  const masterData = createMasterData({
    platform,
    clock,
    newId,
    registerImporter: (definition) => importer.registerImporter(definition),
  });
  const approvals = createApprovals({
    platform,
    clock,
    newId,
    roleCodes: async (tx) => (await identity.roles.list(tx)).map((role) => role.code),
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
  const late: { current?: Attendance } = {};
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
  const lateWages: { current?: Wages } = {};
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
  const paid = { any: false };
  const wages = createWages({
    platform,
    clock,
    newId,
    approvals,
    workforce: override.workforce?.(workforce) ?? workforce,
    attendance: override.attendance?.(attendance) ?? attendance,
    payments: { hasPaidLines: async () => paid.any },
  });
  lateWages.current = wages;

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
    attendance: { db, attendance, platform },
    wages: { db, wages, platform },
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

  const rolesOf = (userId: string) => USERS.filter(([id]) => id === userId).map(([, , r]) => r);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  const grants = {
    ...attendancePermissionGrants,
    ...workforcePermissionGrants,
    ...wagesPermissionGrants,
  } as Record<string, readonly string[]>;
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

  const kit: WagesKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    projects,
    workforce,
    attendance,
    wages,
    app,
    now,
    paid,
    codes,

    async calculated(year = 2026, month = 10) {
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
      await kit.wagesDecide(periodId);
    },

    async wagesDecide(periodId) {
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

    async advance(workerId, amount, monthlyRecovery, issuedOn = '2026-09-15') {
      const actor = await kitActor(ACCOUNTANT);
      const created = await db.transaction((tx) =>
        wages.advances.create({ workerId, amount, monthlyRecovery, issuedOn }, actor, tx),
      );
      return { id: created.id, version: created.version };
    },

    actorFor: kitActor,

    async project(supervisorId = SUPERVISOR) {
      const actor = await kitActor(PM);
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
      if (supervisorId !== null) {
        await db.transaction((tx) =>
          projects.service.setSupervisors(active.id, [{ userId: supervisorId }], actor, tx),
        );
      }
      return active.id;
    },

    async worker(over = {}) {
      workerSeq += 1;
      cnicSeq += 1;
      const actor = await kitActor(MANAGEMENT);
      const worker = await db.transaction((tx) =>
        workforce.workers.create(
          {
            fullName: `Synthetic Worker ${workerSeq}`,
            cnic: String(3520100000000 + cnicSeq),
            tradeCode: 'mason',
            employmentType: 'daily',
            joinedOn: over.joinedOn ?? '2026-01-01',
          },
          actor,
          tx,
        ),
      );
      if (over.amount !== null) {
        const accountant = await kitActor(ACCOUNTANT);
        await db.transaction((tx) =>
          workforce.workers.addRate(
            worker.id,
            {
              payBasis: over.payBasis ?? 'daily_rate',
              amount: over.amount ?? '1000',
              effectiveFrom: '2026-01-01',
            },
            { ...accountant, permissions: new Set([...accountant.permissions]) },
            tx,
          ),
        );
      }
      return { id: worker.id, code: worker.code, fullName: worker.fullName };
    },

    async team(supervisorId = SUPERVISOR) {
      teamSeq += 1;
      const actor = await kitActor(MANAGEMENT);
      const team = await db.transaction((tx) =>
        workforce.teams.create(
          { name: `Synthetic team ${teamSeq}`, supervisorUserId: supervisorId },
          actor,
          tx,
        ),
      );
      return { id: team.id, version: team.version };
    },

    async members(teamId, workerIds, date = '2026-01-01') {
      const actor = await kitActor(MANAGEMENT);
      const team = await workforce.getTeam(db, teamId, actor);
      await db.transaction((tx) =>
        workforce.teams.setMembers(teamId, { workerIds, date }, team.version, actor, tx),
      );
    },

    async setup() {
      const projectA = await kit.project();
      const projectB = await kit.project();
      const team = await kit.team();
      const workerA = await kit.worker();
      const workerB = await kit.worker();
      await kit.members(team.id, [workerA.id, workerB.id]);
      return { projectA, projectB, teamId: team.id, workerA, workerB };
    },

    body(setup, over = {}) {
      return {
        entries: [setup.workerA, setup.workerB].map((worker) => ({
          workerId: worker.id,
          status: 'present' as const,
          allocations: [{ projectId: setup.projectA, fraction: '1' }],
        })),
        ...over,
      };
    },

    async save(setup, date, input, userId = SUPERVISOR) {
      // The actor is read before the transaction: the test database has a single connection.
      const actor = await kitActor(userId);
      return db.transaction((tx) => attendance.sheets.save(setup.teamId, date, input, actor, tx));
    },

    async submit(sheetId, userId = SUPERVISOR) {
      const current = await kit.get(sheetId, ACCOUNTANT);
      const actor = await kitActor(userId);
      return db.transaction((tx) => attendance.sheets.submit(sheetId, current.version, actor, tx));
    },

    async decide(sheetId, action) {
      const state = await approvals.getApprovalState(db, 'attendance_sheet', sheetId);
      if (state.status === 'none') throw new Error('no approval request');
      await db.transaction((tx) =>
        approvals.service.act(
          state.id,
          action,
          { comment: action === 'approve' ? null : 'Check the second worker' },
          { userId: PM, roles: ['project_manager'], scopes: [], requestId: null },
          tx,
        ),
      );
      await kit.dispatch();
    },

    async dispatch() {
      // One dispatch handles at most 50 events, so keep going until nothing is due.
      while ((await platform.events.dispatchDue(db)).dispatched > 0);
    },

    async approved(setup, date = FRIDAY, input = kit.body(setup)) {
      const saved = await kit.save(setup, date, input);
      await kit.submit(saved.id);
      await kit.decide(saved.id, 'approve');
      return kit.get(saved.id, ACCOUNTANT);
    },

    async get(sheetId, userId = ACCOUNTANT) {
      return attendance.sheets.get(db, sheetId, await kitActor(userId));
    },

    async entries(projectId) {
      const page = await projects.costing.listEntries(
        db,
        { type: 'project', id: projectId },
        { limit: 200, offset: 0 },
      );
      return page.items.map((e) => ({
        status: e.status,
        amount: e.amount,
        sourceLineId: e.sourceLineId,
        costCodeId: e.costCodeId,
        entryDate: e.entryDate,
      }));
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
