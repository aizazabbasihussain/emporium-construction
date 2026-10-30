import { randomUUID } from 'node:crypto';
import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  attendancePermissions,
  crmPermissions,
  dprPermissions,
  filesPermissions,
  identityPermissions,
  inventoryPermissions,
  masterdataPermissions,
  notificationsPermissions,
  platformPermissions,
  procurementPermissions,
  projectsPermissions,
  reportsPermissionGrants,
  reportsPermissions,
  valuationPermissions,
  workforcePermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals } from '../approvals/index.js';
import { createAttendance, type Attendance } from '../attendance/index.js';
import { createCrm, type Crm } from '../crm/index.js';
import { createDpr, type Dpr } from '../dpr/index.js';
import { createFiles, type FileStore } from '../files/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createInventory, type Inventory } from '../inventory/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createNotifications } from '../notifications/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createProcurement, type Procurement } from '../procurement/index.js';
import { createProjects, type Projects } from '../projects/index.js';
import { createValuation, type Valuation } from '../valuation/index.js';
import { createWorkforce, type Workforce } from '../workforce/index.js';
import { createReports, type Reports } from './index.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('reports-test-secret-reports-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-9999-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const ACCOUNTANT = uid(4);
export const SUPERVISOR = uid(5);
export const SUPERVISOR2 = uid(6);
export const STOREKEEPER = uid(7);
export const PROCUREMENT = uid(8);
export const NOBODY = uid(9);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [SUPERVISOR2, 'supervisor2@example.test', 'supervisor'],
  [STOREKEEPER, 'storekeeper@example.test', 'storekeeper'],
  [PROCUREMENT, 'procurement@example.test', 'procurement'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

/** The clock of the kit: Sunday 25 October 2026, 15:00 in Karachi. */
export const TODAY = '2026-10-25';
export const FRIDAY = '2026-10-23';

/** An in-memory object store: the tests never touch the disk or the network. */
function memoryStore(): FileStore {
  const objects = new Map<string, Uint8Array>();
  return {
    put: (key, bytes) => {
      objects.set(key, bytes);
      return Promise.resolve();
    },
    getSignedUrl: (key) => Promise.resolve(`https://files.example.test/${key}`),
    delete: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
    exists: (key) => Promise.resolve(objects.has(key)),
  };
}

export interface ScenarioIds {
  projectA: string;
  projectA_code: string;
  projectB: string;
  projectB_code: string;
  projectC: string;
  projectC_code: string;
  codes: Record<string, string>;
  store: string;
  storeCode: string;
  item1: string;
  item2: string;
  clientItem: string;
  clientParty: string;
  vendor: string;
  po: string;
  leadOverdue: string;
}

export interface ReportsKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  projects: Projects;
  inventory: Inventory;
  procurement: Procurement;
  attendance: Attendance;
  crm: Crm;
  dpr: Dpr;
  workforce: Workforce;
  reports: Reports;
  app: FastifyInstance;
  now: { current: Date };
  /** A caller holding the report permissions its roles get from the migration. */
  actorFor(userId: string, scopes?: Actor['scopes']): Actor;
  /** Builds the scripted dataset once; the figures in the tests are calculated from it by hand. */
  seed(): Promise<ScenarioIds>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let workerSeq = 0;

export async function createReportsKit(): Promise<ReportsKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-9999-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  const registered = {
    platform: platformPermissions,
    identity: identityPermissions,
    approvals: approvalsPermissions,
    files: filesPermissions,
    notifications: notificationsPermissions,
    master: masterdataPermissions,
    crm: crmPermissions,
    valuation: valuationPermissions,
    projects: projectsPermissions,
    procurement: procurementPermissions,
    inventory: inventoryPermissions,
    dpr: dprPermissions,
    workforce: workforcePermissions,
    attendance: attendancePermissions,
    reports: reportsPermissions,
  };
  for (const [module, permissions] of Object.entries(registered)) {
    identity.registerPermissions(module, Object.values(permissions));
  }
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
    getApprovalState: approvals.getApprovalState,
  });
  const files = createFiles({ platform, clock, newId, newKey: randomUUID, store: memoryStore() });
  const valuation: Valuation = createValuation({ platform, clock, newId, masterData, approvals });
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
  const inventory = createInventory({
    platform,
    clock,
    newId,
    valuation,
    projects,
    masterData,
    approvals,
    notifications,
  });
  const procurement = createProcurement({
    platform,
    clock,
    newId,
    projects,
    approvals,
    masterData,
    files,
    guards: { isIssued: async () => false, isBilled: async () => false },
  });
  const crm = createCrm({ platform, clock, newId, masterData, notifications, files });
  const dpr = createDpr({ platform, clock, newId, projects, files, notifications });
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
    registerImporter: () => undefined,
  });
  const attendance = createAttendance({
    platform,
    clock,
    newId,
    projects,
    approvals,
    masterData,
    workforce,
    wages: { approvedPeriodOf: async () => null },
  });
  late.current = attendance;
  const reports = createReports({
    platform,
    clock,
    newId,
    projects,
    procurement,
    inventory,
    attendance,
    crm,
    dpr,
    masterData,
  });

  for (const [id, email, role] of USERS) {
    await db.query(
      'insert into sys_users (id, auth_subject, email, full_name) values ($1, $2, $2, $2)',
      [id, email],
    );
    await db.query('insert into sys_user_roles (user_id, role_code) values ($1, $2)', [id, role]);
  }

  const app = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => now.current,
    identity: { db, identity },
    reports: { db, reports: reports.service, platform },
  });
  await app.ready();

  const rolesOf = (userId: string) => USERS.filter(([id]) => id === userId).map(([, , r]) => r);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  const everything = new Set<string>(
    Object.values(registered).flatMap((permissions) => Object.values(permissions)),
  );
  /** Setup acts as a user who may do everything; the reports are asked as the real roles. */
  const setupActor = (userId: string, scopes: Actor['scopes'] = []): Actor => ({
    userId,
    roles: rolesOf(userId),
    scopes,
    permissions: everything,
    requestId: null,
  });
  const admin = { userId: ADMIN, requestId: null };

  const kit: ReportsKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    projects,
    inventory,
    procurement,
    attendance,
    crm,
    dpr,
    workforce,
    reports,
    app,
    now,

    actorFor(userId, scopes = []) {
      const roles = rolesOf(userId);
      return {
        userId,
        roles,
        scopes,
        permissions: new Set(
          Object.entries(reportsPermissionGrants)
            .filter(([, granted]) => granted.some((role) => roles.includes(role)))
            .map(([permission]) => permission),
        ),
        requestId: null,
        name: emailOf(userId),
      };
    },

    async seed() {
      const tx = <T>(run: (t: SqlDb) => Promise<T>) => db.transaction(run);
      const codes = Object.fromEntries(
        (await masterData.costing.listCostCodes(db)).map((code) => [code.code, code.id]),
      ) as Record<string, string>;
      const decide = async (docType: string, id: string, userId: string, role: string) => {
        const state = await approvals.getApprovalState(db, docType, id);
        if (state.status === 'none') throw new Error('no approval request');
        await tx((t) =>
          approvals.service.act(
            state.id,
            'approve',
            { comment: null },
            { userId, roles: [role], scopes: [], requestId: null },
            t,
          ),
        );
        while ((await platform.events.dispatchDue(db)).dispatched > 0);
      };
      const setting = async (key: string, value: unknown) => {
        const current = await platform.settings.get(db, key);
        await tx((t) =>
          platform.settings.set(
            { key, value, expectedVersion: current.version },
            { actorUserId: ADMIN, requestId: null },
            t,
          ),
        );
      };
      await setting('dpr_photo_required', false);
      await setting('procurement.grn_photo_required', false);

      const client = await tx((t) =>
        masterData.parties.create({ name: 'Synthetic Client', roles: ['client'] }, admin, t),
      );
      const vendor = await tx((t) =>
        masterData.parties.create({ name: 'Synthetic Vendor', roles: ['vendor'] }, admin, t),
      );
      const item = async (code: string, defaultCostCode: string | null = null) =>
        (
          await tx((t) =>
            masterData.catalog.createItem(
              {
                code,
                name: `Synthetic ${code}`,
                unitCode: 'bag',
                itemKind: 'material',
                stockable: true,
                defaultTaxKind: 'goods',
                defaultCostCodeId: defaultCostCode,
              },
              admin,
              t,
            ),
          )
        ).id;
      const item1 = await item('RPT-CEMENT', codes['100']);
      const item2 = await item('RPT-STEEL', codes['100']);
      const clientItem = await item('RPT-CLIENT-TILE', codes['100']);

      // Projects: A has budgets on 100 and 200, B on 100 only, C has nothing to report.
      const pm = setupActor(PM);
      const project = async (
        name: string,
        budget: [string, string][],
        supervisor?: string,
        extra: { startDate?: string; status?: 'on_hold' } = {},
      ) => {
        const created = await tx((t) =>
          projects.service.create(
            {
              name,
              partyId: client.id,
              sector: 'private',
              originalContractValue: '1000000',
              startDate: extra.startDate ?? null,
            },
            pm,
            t,
          ),
        );
        await tx((t) =>
          projects.service.replaceBudget(
            created.id,
            budget.map(([code, amount]) => ({
              costCodeId: codes[code] as string,
              budgetAmount: amount,
            })),
            created.version,
            pm,
            t,
          ),
        );
        const current = await projects.getProject(db, created.id);
        const active = await tx((t) =>
          projects.service.transition(created.id, 'active', current.version, pm, t),
        );
        if (supervisor !== undefined) {
          await tx((t) =>
            projects.service.setSupervisors(active.id, [{ userId: supervisor }], pm, t),
          );
        }
        if (extra.status === 'on_hold') {
          await tx((t) => projects.service.transition(active.id, 'on_hold', active.version, pm, t));
        }
        return { id: active.id, code: active.code };
      };
      const projectA = await project(
        'Alpha boundary wall',
        [
          ['100', '100000'],
          ['200', '50000'],
        ],
        SUPERVISOR,
      );
      const projectB = await project('Beta site office', [['100', '10000']], SUPERVISOR);
      // C starts on Thursday 22 October and has nothing to report; D is paused.
      const projectC = await project('Gamma idle', [], undefined, { startDate: '2026-10-22' });
      await project('Delta paused', [], undefined, { status: 'on_hold' });

      // Direct cost entries: posted on A/100 and A/500 and B/100.
      const post = (
        projectId: string,
        costCode: string,
        status: 'committed' | 'approved' | 'posted',
        amount: string,
        line: string,
      ) =>
        tx((t) =>
          projects.postCost(
            {
              costObject: { type: 'project', id: projectId },
              costCodeId: codes[costCode] as string,
              amount,
              status,
              sourceModule: 'reports-test',
              sourceDocType: 'scenario',
              sourceDocId: uid(Number(line)),
              sourceLineId: uid(Number(line)),
              entryDate: '2026-10-20',
              description: `Scenario ${line}`,
              idempotencyKey: `scenario:${line}`,
            },
            t,
          ),
        );
      await post(projectA.id, '100', 'posted', '28000.00', '501');
      await post(projectA.id, '500', 'posted', '700.00', '502');
      await post(projectB.id, '100', 'posted', '12000.00', '503');

      // Stock: a warehouse with cement and steel, a client's tiles.
      const storeActor = setupActor(STOREKEEPER);
      const store = await tx((t) =>
        inventory.service.stores.create(
          { code: 'RPT-WH', name: 'Reports warehouse', kind: 'warehouse', projectId: null },
          storeActor,
          t,
        ),
      );
      const receive = async (itemId: string, quantity: string, unitCost: string) => {
        const grnId = newId();
        await tx((t) =>
          platform.events.publish(
            {
              type: 'goods.received',
              payload: {
                grnId,
                grnNumber: `GRN-RPT-${grnId.slice(-4)}`,
                poId: newId(),
                lines: [
                  {
                    grnLineId: newId(),
                    itemId,
                    quantity,
                    unitCost,
                    costCodeId: codes['100'],
                  },
                ],
                destinationType: 'store',
                storeId: store.id,
                projectId: null,
                ownership: 'company',
              },
            },
            t,
          ),
        );
        while ((await platform.events.dispatchDue(db)).dispatched > 0);
      };
      await receive(item1, '100', '50');
      await receive(item2, '10', '200');
      await tx((t) =>
        inventory.issueToCostObject(
          {
            businessDate: TODAY,
            costObject: { type: 'project', id: projectA.id },
            storeId: store.id,
            itemId: item1,
            quantity: '40',
          },
          storeActor,
          t,
        ),
      );
      await tx((t) =>
        inventory.service.stores.setReorderLevel(
          { storeId: store.id, itemId: item1, level: '100' },
          storeActor,
          t,
        ),
      );
      await tx((t) =>
        inventory.service.stores.setReorderLevel(
          { storeId: store.id, itemId: item2, level: '5' },
          storeActor,
          t,
        ),
      );
      const clientBase = {
        storeId: store.id,
        itemId: clientItem,
        ownerPartyId: client.id,
        projectId: projectA.id,
        businessDate: TODAY,
      };
      await tx((t) =>
        inventory.receiveClientMaterial({ ...clientBase, quantity: '20' }, storeActor, t),
      );
      await tx((t) =>
        inventory.issueToCostObject(
          {
            businessDate: TODAY,
            costObject: { type: 'project', id: projectA.id },
            storeId: store.id,
            itemId: clientItem,
            quantity: '8',
            ownership: 'client',
            ownerPartyId: client.id,
          },
          storeActor,
          t,
        ),
      );
      await tx((t) =>
        inventory.service.stock.returnClientMaterial(
          { ...clientBase, quantity: '2' },
          storeActor,
          t,
        ),
      );

      // Procurement: an approved order on project A with 50 of 200 bags received, and a request.
      const procurementActor = setupActor(PROCUREMENT);
      const draft = await tx((t) =>
        procurement.service.orders.create(
          {
            vendorId: vendor.id,
            projectId: projectA.id,
            orderDate: '2026-10-19',
            expectedDate: '2026-10-20',
            terms: 'Delivery to site',
            lines: [
              { itemId: item1, quantity: '200', rate: '100', costCodeId: codes['100'] as string },
              { itemId: item2, quantity: '10', rate: '50', costCodeId: codes['100'] as string },
            ],
          },
          procurementActor,
          t,
        ),
      );
      await tx((t) =>
        procurement.service.orders.submit(draft.id, draft.version, procurementActor, t),
      );
      await decide('purchase_order', draft.id, MANAGEMENT, 'management');
      // A second order to the warehouse, expected after today.
      const second = await tx((t) =>
        procurement.service.orders.create(
          {
            vendorId: vendor.id,
            storeId: store.id,
            orderDate: '2026-10-24',
            expectedDate: '2026-11-05',
            terms: 'Delivery to the warehouse',
            lines: [
              { itemId: item2, quantity: '10', rate: '50', costCodeId: codes['100'] as string },
            ],
          },
          procurementActor,
          t,
        ),
      );
      await tx((t) =>
        procurement.service.orders.submit(second.id, second.version, procurementActor, t),
      );
      await decide('purchase_order', second.id, MANAGEMENT, 'management');
      const order = await procurement.getPurchaseOrder(db, draft.id);
      await tx((t) =>
        procurement.service.receipts.create(
          {
            poId: draft.id,
            receivedOn: '2026-10-24',
            deliveryNoteRef: 'DC-RPT',
            lines: [{ poLineId: (order.lines[0] as { id: string }).id, acceptedQty: '50' }],
            photos: [],
          },
          setupActor(STOREKEEPER),
          t,
        ),
      );
      const requisition = await tx((t) =>
        procurement.service.requisitions.create(
          {
            projectId: projectA.id,
            note: 'Sand for the plaster',
            lines: [{ itemId: item1, quantity: '30', costCodeId: codes['100'] as string }],
          },
          procurementActor,
          t,
        ),
      );
      await tx((t) =>
        procurement.service.requisitions.submit(
          requisition.id,
          requisition.version,
          procurementActor,
          t,
        ),
      );
      await tx((t) =>
        procurement.service.requisitions.create(
          {
            projectId: projectA.id,
            note: 'A draft that nobody sent',
            lines: [{ itemId: item2, quantity: '1', costCodeId: codes['100'] as string }],
          },
          procurementActor,
          t,
        ),
      );

      // Attendance on Friday 23 October: W1 a full day on A; W2 half a day with 2 hours overtime
      // shared between A and B. Daily rate 1,000, overtime 1.5 times the hourly rate.
      const workerActor = setupActor(MANAGEMENT);
      const worker = async () => {
        workerSeq += 1;
        const created = await tx((t) =>
          workforce.workers.create(
            {
              fullName: `Report Worker ${workerSeq}`,
              cnic: String(3520200000000 + workerSeq),
              tradeCode: 'mason',
              employmentType: 'daily',
              joinedOn: '2026-01-01',
            },
            workerActor,
            t,
          ),
        );
        await tx((t) =>
          workforce.workers.addRate(
            created.id,
            { payBasis: 'daily_rate', amount: '1000', effectiveFrom: '2026-01-01' },
            setupActor(ACCOUNTANT),
            t,
          ),
        );
        return created.id;
      };
      const w1 = await worker();
      const w2 = await worker();
      const team = await tx((t) =>
        workforce.teams.create(
          { name: 'Reports team', supervisorUserId: SUPERVISOR },
          workerActor,
          t,
        ),
      );
      const teamRow = await workforce.getTeam(db, team.id, workerActor);
      await tx((t) =>
        workforce.teams.setMembers(
          team.id,
          { workerIds: [w1, w2], date: '2026-01-01' },
          teamRow.version,
          workerActor,
          t,
        ),
      );
      const supervisorUser = (await identity.users.list(db)).find((u) => u.id === SUPERVISOR);
      const supervisor = setupActor(SUPERVISOR, supervisorUser?.scopes ?? []);
      const sheet = await tx((t) =>
        attendance.sheets.save(
          team.id,
          FRIDAY,
          {
            entries: [
              {
                workerId: w1,
                status: 'present',
                allocations: [{ projectId: projectA.id, fraction: '1' }],
              },
              {
                workerId: w2,
                status: 'half_day',
                overtimeHours: '2',
                allocations: [
                  { projectId: projectA.id, fraction: '0.5' },
                  { projectId: projectB.id, fraction: '0.5' },
                ],
              },
            ],
          },
          supervisor,
          t,
        ),
      );
      await tx((t) => attendance.sheets.submit(sheet.id, sheet.version, supervisor, t));
      await decide('attendance_sheet', sheet.id, PM, 'project_manager');

      // Daily reports in the week of 19 October: A on four days (not Thursday), B on two.
      const report = async (
        projectId: string,
        date: string,
        mode: 'submitted' | 'draft' | 'reviewed' = 'submitted',
      ) => {
        // Reports are written on their own day, which keeps them inside the backdating allowance.
        now.current = new Date(`${date}T10:00:00Z`);
        const actor = setupActor(PM);
        const created = await tx((t) =>
          dpr.reports.create(
            {
              projectId,
              reportDate: date,
              weather: 'clear',
              workDone: 'Poured the first lift of the roof slab',
              issues: '',
              safetyNotes: '',
              manpowerManual: [],
            },
            actor,
            t,
          ),
        );
        if (mode === 'draft') return;
        const filed = await tx((t) => dpr.reports.submit(created.id, created.version, actor, t));
        if (mode === 'reviewed') {
          await tx((t) => dpr.reports.review(created.id, undefined, filed.version, actor, t));
        }
      };
      // A has a reviewed report on Monday and submitted ones on Tuesday, Wednesday and Friday.
      await report(projectA.id, '2026-10-19', 'reviewed');
      for (const date of ['2026-10-20', '2026-10-21', '2026-10-23']) {
        await report(projectA.id, date);
      }
      for (const date of ['2026-10-19', '2026-10-20']) await report(projectB.id, date);
      // B's Wednesday report was started and never sent, so that day is still missing.
      await report(projectB.id, '2026-10-21', 'draft');
      now.current = new Date('2026-10-25T10:00:00Z');

      // Leads: open in two stages, one won on 10 October, one lost on 12 October.
      const leadActor = setupActor(PM);
      const lead = (over: Record<string, unknown>) =>
        tx((t) =>
          crm.service.createLead(
            {
              contactName: 'Synthetic Contact',
              contactPhone: '0300 1234567',
              workType: 'new_build',
              sector: 'private',
              sourceCode: 'referral',
              ...over,
            },
            leadActor,
            t,
          ),
        );
      const move = (l: { id: string; version: number }, stageCode: string, loss?: string) =>
        tx((t) =>
          crm.service.moveStage(
            l.id,
            { stageCode, lossReasonCode: loss },
            l.version,
            false,
            leadActor,
            t,
          ),
        );
      const open1 = await lead({ expectedValue: '1000000' });
      const open2 = await lead({ expectedValue: '500000' });
      await move(open2, 'visited');
      const won = await lead({ expectedValue: '250000', partyId: client.id });
      const lost = await lead({ expectedValue: '300000' });
      now.current = new Date('2026-10-10T08:00:00Z');
      await move(won, 'won');
      now.current = new Date('2026-10-12T08:00:00Z');
      await move(lost, 'lost', 'price');
      now.current = new Date('2026-10-25T10:00:00Z');
      await tx((t) => crm.service.addFollowUp(open1.id, { dueDate: '2026-10-20' }, leadActor, t));
      await tx((t) => crm.service.addFollowUp(open2.id, { dueDate: TODAY }, leadActor, t));

      return {
        projectA: projectA.id,
        projectA_code: projectA.code,
        projectB: projectB.id,
        projectB_code: projectB.code,
        projectC: projectC.id,
        projectC_code: projectC.code,
        codes,
        store: store.id,
        storeCode: 'RPT-WH',
        item1,
        item2,
        clientItem,
        clientParty: client.id,
        vendor: vendor.id,
        po: draft.id,
        leadOverdue: open1.id,
      };
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

    close: () => app.close(),
  };
  return kit;
}
