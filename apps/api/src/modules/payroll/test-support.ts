import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  attendancePermissionGrants,
  attendancePermissions,
  cashbookPermissionGrants,
  cashbookPermissions,
  identityPermissions,
  importerPermissions,
  masterdataPermissions,
  payrollPermissionGrants,
  payrollPermissions,
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
import { createCashbook, type Cashbook } from '../cashbook/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createImporter } from '../importer/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createProjects, type Projects } from '../projects/index.js';
import { createWages, type Wages } from '../wages/index.js';
import { createWorkforce, type Workforce } from '../workforce/index.js';
import { createPayroll, type Payroll, type PayrollDeps } from './index.js';
import type { Actor } from './types.js';

// A module may not import another module's test support, so this kit builds what it needs itself:
// the kernel, master data, approvals, projects, workforce, attendance, wages and the cash book.

const SECRET = new TextEncoder().encode('payroll-test-secret-payroll-test-secret-payroll-test');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-bbbb-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const ACCOUNTANT = uid(4);
export const SUPERVISOR = uid(5);
export const NOBODY = uid(6);
/** A second accountant: the person who finalizes is not always the person who pays. */
export const ACCOUNTANT2 = uid(7);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
  [ACCOUNTANT2, 'accountant2@example.test', 'accountant'],
];

/** The clock of every kit: Sunday 25 October 2026, 15:00 in Karachi. */
export const TODAY = '2026-10-25';
export const FRIDAY = '2026-10-23';
export const THURSDAY = '2026-10-22';

type Sheet = Awaited<ReturnType<Wages['getApprovedWageSheet']>>;
type Reconciliation = Awaited<ReturnType<Wages['periods']['reconciliation']>>;

/** Lets a test bend what payroll reads from wages (a stale sheet, a different reconciliation). */
export interface Tweaks {
  sheet?: ((real: Sheet) => Sheet) | undefined;
  reconciliation?: ((real: Reconciliation) => Reconciliation) | undefined;
}

export interface Setup {
  projectA: string;
  projectB: string;
  teamId: string;
  workerA: { id: string; code: string; fullName: string };
  workerB: { id: string; code: string; fullName: string };
}

export interface Month extends Setup {
  periodId: string;
}

type SheetInput = Parameters<Attendance['sheets']['save']>[2];

export interface PayrollKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  projects: Projects;
  workforce: Workforce;
  attendance: Attendance;
  wages: Wages;
  cashbook: Cashbook;
  payroll: Payroll;
  app: FastifyInstance;
  now: { current: Date };
  tweaks: Tweaks;
  codes: Record<string, string>;
  actorFor(userId: string): Promise<Actor>;
  /** Two projects, a team and two workers (daily rate 1,000). */
  setup(): Promise<Setup>;
  /**
   * October 2026 with both workers present on the given dates (project A, full day; the first
   * date also has worker B on project B), calculated and approved. An allowance on worker A makes
   * the wage gross higher than the attendance cost.
   */
  month(over?: { dates?: string[]; allowance?: string; withB?: boolean }): Promise<Month>;
  /** A draft run of the period, created by the accountant. */
  run(periodId: string): Promise<Awaited<ReturnType<Payroll['runs']['create']>>>;
  /** A run that is created and finalized by the accountant. */
  finalized(
    periodId: string,
    treatment?: 'spread_to_projects' | 'overhead',
  ): Promise<Awaited<ReturnType<Payroll['runs']['finalize']>>>;
  /** A cash book bank account with money in it. */
  bank(opening?: string): Promise<string>;
  balance(accountId: string): Promise<string>;
  /** The owner approves a payment request (a `payment` document) and the events are delivered. */
  approvePayment(docId: string, userId?: string): Promise<void>;
  /** Asks for approval, has the owner approve it and returns the request to pass to pay. */
  approvedRequest(runId: string, lineIds?: string[]): Promise<string | undefined>;
  setSetting(key: string, value: unknown): Promise<void>;
  /** Committed, approved and posted totals of a project. */
  totals(projectId: string): Promise<{ committed: string; approved: string; posted: string }>;
  overheadTotals(): Promise<{ committed: string; approved: string; posted: string }>;
  /** The cost ledger rows of a project, oldest first. */
  ledger(
    projectId: string,
  ): Promise<{ status: string; amount: string; sourceModule: string; sourceDocType: string }[]>;
  dispatch(): Promise<void>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let workerSeq = 0;
let cnicSeq = 0;
let accountSeq = 0;

export async function createPayrollKit(
  override: { deps?: (real: PayrollDeps) => PayrollDeps } = {},
): Promise<PayrollKit> {
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
  identity.registerPermissions('cashbook', Object.values(cashbookPermissions));
  identity.registerPermissions('payroll', Object.values(payrollPermissions));
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
  const latePayroll: { current?: Payroll } = {};
  const wages = createWages({
    platform,
    clock,
    newId,
    approvals,
    workforce,
    attendance,
    payments: {
      hasPaidLines: (tx, periodId) => (latePayroll.current as Payroll).hasPaidLines(tx, periodId),
    },
  });
  lateWages.current = wages;
  const cashbook = createCashbook({ platform, clock, newId, approvals });
  const tweaks: Tweaks = {};
  const realDeps: PayrollDeps = {
    platform,
    clock,
    newId,
    wages: {
      getApprovedWageSheet: async (tx, period) => {
        const sheet = await wages.getApprovedWageSheet(tx, period);
        return tweaks.sheet === undefined ? sheet : tweaks.sheet(sheet);
      },
      periods: {
        get: (tx, id) => wages.periods.get(tx, id),
        reconciliation: async (tx, id) => {
          const real = await wages.periods.reconciliation(tx, id);
          return tweaks.reconciliation === undefined ? real : tweaks.reconciliation(real);
        },
      },
    },
    attendance,
    projects,
    cashbook,
    approvals,
    masterData,
  };
  const payroll = createPayroll(override.deps === undefined ? realDeps : override.deps(realDeps));
  latePayroll.current = payroll;

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
    payroll: { db, payroll, platform },
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
    ...cashbookPermissionGrants,
    ...payrollPermissionGrants,
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

  const dispatch = async () => {
    // One dispatch handles at most 50 events, so keep going until nothing is due.
    while ((await platform.events.dispatchDue(db)).dispatched > 0);
  };

  const decide = async (docType: string, docId: string, userId: string, role: string) => {
    const state = await approvals.getApprovalState(db, docType, docId);
    if (state.status === 'none') throw new Error('no approval request');
    await db.transaction((tx) =>
      approvals.service.act(
        state.id,
        'approve',
        { comment: null },
        { userId, roles: [role], scopes: [], requestId: null },
        tx,
      ),
    );
    await dispatch();
  };

  const body = (setup: Setup, withB: boolean): SheetInput => ({
    entries: [setup.workerA, setup.workerB].map((worker, index) => ({
      workerId: worker.id,
      status: 'present' as const,
      allocations: [
        { projectId: withB && index === 1 ? setup.projectB : setup.projectA, fraction: '1' },
      ],
    })),
  });

  const kit: PayrollKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    projects,
    workforce,
    attendance,
    wages,
    cashbook,
    payroll,
    app,
    now,
    tweaks,
    codes,
    actorFor: kitActor,

    async setup() {
      const pm = await kitActor(PM);
      const makeProject = async () => {
        const created = await db.transaction((tx) =>
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
        const active = await db.transaction((tx) =>
          projects.service.transition(created.id, 'active', created.version, pm, tx),
        );
        await db.transaction((tx) =>
          projects.service.setSupervisors(active.id, [{ userId: SUPERVISOR }], pm, tx),
        );
        return active.id;
      };
      const projectA = await makeProject();
      const projectB = await makeProject();
      const management = await kitActor(MANAGEMENT);
      const team = await db.transaction((tx) =>
        workforce.teams.create(
          { name: `Synthetic team ${++workerSeq}`, supervisorUserId: SUPERVISOR },
          management,
          tx,
        ),
      );
      const makeWorker = async () => {
        workerSeq += 1;
        cnicSeq += 1;
        const worker = await db.transaction((tx) =>
          workforce.workers.create(
            {
              fullName: `Synthetic Worker ${workerSeq}`,
              cnic: String(3520100000000 + cnicSeq),
              tradeCode: 'mason',
              employmentType: 'daily',
              joinedOn: '2026-01-01',
            },
            management,
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
      const workerA = await makeWorker();
      const workerB = await makeWorker();
      const teamRow = await workforce.getTeam(db, team.id, management);
      await db.transaction((tx) =>
        workforce.teams.setMembers(
          team.id,
          { workerIds: [workerA.id, workerB.id], date: '2026-01-01' },
          teamRow.version,
          management,
          tx,
        ),
      );
      return { projectA, projectB, teamId: team.id, workerA, workerB };
    },

    async month(over = {}) {
      const setup = await kit.setup();
      const supervisor = await kitActor(SUPERVISOR);
      const accountant = await kitActor(ACCOUNTANT);
      const dates = over.dates ?? [FRIDAY, THURSDAY];
      for (const [index, date] of dates.entries()) {
        const saved = await db.transaction((tx) =>
          attendance.sheets.save(
            setup.teamId,
            date,
            body(setup, over.withB === true && index === 0),
            supervisor,
            tx,
          ),
        );
        const current = await attendance.sheets.get(db, saved.id, accountant);
        await db.transaction((tx) =>
          attendance.sheets.submit(saved.id, current.version, supervisor, tx),
        );
        await decide('attendance_sheet', saved.id, PM, 'project_manager');
      }
      const period = await db.transaction((tx) =>
        wages.periods.create({ year: 2026, month: 10 }, accountant, tx),
      );
      await db.transaction((tx) => wages.periods.calculate(period.id, accountant, tx));
      if (over.allowance !== undefined) {
        const { lines } = await wages.periods.lines(db, period.id);
        const line = lines.find((l) => l.workerId === setup.workerA.id);
        await db.transaction((tx) =>
          wages.periods.addAdjustment(
            (line as { id: string }).id,
            { kind: 'allowance', amount: over.allowance as string, reason: 'Site allowance' },
            accountant,
            tx,
          ),
        );
      }
      const detail = await wages.periods.get(db, period.id);
      await db.transaction((tx) =>
        wages.periods.submit(
          period.id,
          { version: detail.version, acknowledgeWarnings: true },
          accountant,
          tx,
        ),
      );
      await decide('wage_period', period.id, MANAGEMENT, 'management');
      return { ...setup, periodId: period.id };
    },

    async run(periodId) {
      const actor = await kitActor(ACCOUNTANT);
      return db.transaction((tx) => payroll.runs.create({ periodId }, actor, tx));
    },

    async finalized(periodId, treatment) {
      const actor = await kitActor(ACCOUNTANT);
      const run = await kit.run(periodId);
      return db.transaction((tx) =>
        payroll.runs.finalize(
          run.id,
          { version: run.version, costDifferenceTreatment: treatment },
          actor,
          tx,
        ),
      );
    },

    async bank(opening = '1000000') {
      accountSeq += 1;
      const actor = await kitActor(ACCOUNTANT);
      const account = await db.transaction((tx) =>
        cashbook.accounts.create(
          {
            code: `PAY-BANK-${accountSeq}`,
            name: `Payroll bank ${accountSeq}`,
            kind: 'bank',
            openingBalance: opening,
            openingDate: '2026-01-01',
          },
          actor,
          tx,
        ),
      );
      return account.id;
    },

    async balance(accountId) {
      return cashbook.getAccountBalance(db, accountId, TODAY);
    },

    async approvePayment(docId, userId = MANAGEMENT) {
      await decide('payment', docId, userId, rolesOf(userId)[0] as string);
    },

    async approvedRequest(runId, lineIds) {
      const actor = await kitActor(ACCOUNTANT);
      const request = await db.transaction((tx) =>
        payroll.payments.requestPayment(runId, { lineIds }, actor, tx),
      );
      if (request.approvalDocId !== null) await kit.approvePayment(request.approvalDocId);
      return request.approvalDocId ?? undefined;
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

    async totals(projectId) {
      return (await projects.getCostSummary(db, { type: 'project', id: projectId })).totals;
    },

    async overheadTotals() {
      return (await projects.getCostSummary(db, { type: 'overhead', id: null })).totals;
    },

    async ledger(projectId) {
      const page = await projects.costing.listEntries(
        db,
        { type: 'project', id: projectId },
        { limit: 200, offset: 0 },
      );
      return [...page.items].reverse().map((entry) => ({
        status: entry.status,
        amount: entry.amount,
        sourceModule: entry.sourceModule,
        sourceDocType: entry.sourceDocType,
      }));
    },

    dispatch,

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
