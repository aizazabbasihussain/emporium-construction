import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  identityPermissions,
  inventoryPermissions,
  masterdataPermissions,
  notificationsPermissions,
  platformPermissions,
  projectsPermissions,
  valuationPermissions,
  type ValuationMethod,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals } from '../approvals/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createNotifications, type Notifications } from '../notifications/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createProjects, type Projects } from '../projects/index.js';
import { createValuation, type Valuation } from '../valuation/index.js';
import { createInventory, type Inventory } from './index.js';
import type { IssueCommand } from './service/stock.service.js';
import type { Actor, MovementDto } from './types.js';

const SECRET = new TextEncoder().encode('inventory-test-secret-inventory-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-8888-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const PROCUREMENT = uid(4);
export const STOREKEEPER = uid(5);
export const SUPERVISOR = uid(6);
export const SUPERVISOR2 = uid(7);
export const ACCOUNTANT = uid(8);
export const NOBODY = uid(9);
export const MISSING = uid(999);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [PROCUREMENT, 'procurement@example.test', 'procurement'],
  [STOREKEEPER, 'storekeeper@example.test', 'storekeeper'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [SUPERVISOR2, 'supervisor2@example.test', 'supervisor'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

export interface CostRow {
  status: string;
  amount: string;
  sourceDocType: string;
  reverses: boolean;
}

export interface InventoryKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  notifications: Notifications;
  projects: Projects;
  valuation: Valuation;
  inventory: Inventory;
  app: FastifyInstance;
  now: { current: Date };
  codes: Record<string, string>;
  /** The storekeeper: holds every inventory permission. */
  actor: Actor;
  actorFor(userId: string, scopes?: Actor['scopes']): Actor;
  clientParty: string;
  project(): Promise<{ id: string; code: string }>;
  assignSupervisor(projectId: string, userId: string): Promise<void>;
  store(over?: {
    kind?: 'warehouse' | 'site';
    projectId?: string | null;
    code?: string;
  }): Promise<string>;
  item(over?: {
    code?: string;
    defaultCostCode?: string | null;
    stockable?: boolean;
  }): Promise<string>;
  /** Publishes `goods.received` for a store and delivers it, as procurement does. */
  receive(
    storeId: string,
    lines: { itemId: string; quantity: string; unitCost: string }[],
    grnId?: string,
  ): Promise<{ grnId: string; lineIds: string[] }>;
  issue(
    over: Partial<IssueCommand> & Pick<IssueCommand, 'storeId' | 'itemId' | 'quantity'>,
    projectId: string,
  ): Promise<MovementDto>;
  stock(storeId: string, itemId: string): Promise<string>;
  costs(projectId: string): Promise<CostRow[]>;
  setting(key: string, value: string | boolean): Promise<void>;
  activatePolicy(method: ValuationMethod): Promise<void>;
  decide(docType: string, id: string, action: 'approve' | 'reject' | 'return'): Promise<void>;
  notificationCount(template: string): Promise<number>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let keyCounter = 0;

export async function createInventoryKit(): Promise<InventoryKit> {
  const db = await createTestDb();
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
  identity.registerPermissions('approvals', Object.values(approvalsPermissions));
  identity.registerPermissions('notifications', Object.values(notificationsPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('projects', Object.values(projectsPermissions));
  identity.registerPermissions('valuation', Object.values(valuationPermissions));
  identity.registerPermissions('inventory', Object.values(inventoryPermissions));
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
  const valuation = createValuation({ platform, clock, newId, masterData, approvals });
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
    inventory: { db, inventory, platform },
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
  const codes = Object.fromEntries(
    (await masterData.costing.listCostCodes(db)).map((code) => [code.code, code.id]),
  );

  const allPermissions = new Set<string>([
    ...Object.values(inventoryPermissions),
    ...Object.values(projectsPermissions),
  ]);
  const actorFor = (userId: string, scopes: Actor['scopes'] = []): Actor => ({
    userId,
    roles: USERS.filter(([id]) => id === userId).map(([, , role]) => role),
    scopes,
    permissions: allPermissions,
    requestId: null,
  });
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  let itemSeq = 0;
  let storeSeq = 0;

  const kit: InventoryKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    notifications,
    projects,
    valuation,
    inventory,
    app,
    now,
    codes,
    actor: actorFor(STOREKEEPER),
    actorFor,
    clientParty: client.id,

    async project() {
      const pm = actorFor(PM);
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
      return { id: active.id, code: active.code };
    },

    async assignSupervisor(projectId, userId) {
      await db.transaction((tx) =>
        projects.service.setSupervisors(projectId, [{ userId }], actorFor(PM), tx),
      );
    },

    async store(over = {}) {
      storeSeq += 1;
      const created = await db.transaction((tx) =>
        inventory.service.stores.create(
          {
            code: over.code ?? `ST-${storeSeq}`,
            name: `Synthetic store ${storeSeq}`,
            kind: over.kind ?? (over.projectId ? 'site' : 'warehouse'),
            projectId: over.projectId ?? null,
          },
          actorFor(STOREKEEPER),
          tx,
        ),
      );
      return created.id;
    },

    async item(over = {}) {
      itemSeq += 1;
      const created = await db.transaction((tx) =>
        masterData.catalog.createItem(
          {
            code: over.code ?? `INV-ITEM-${itemSeq}`,
            name: `Synthetic item ${itemSeq}`,
            unitCode: 'bag',
            itemKind: 'material',
            stockable: over.stockable ?? true,
            defaultTaxKind: 'goods',
            defaultCostCodeId:
              over.defaultCostCode === undefined ? codes['100'] : over.defaultCostCode,
          },
          admin,
          tx,
        ),
      );
      return created.id;
    },

    async receive(storeId, lines, grnId = newId()) {
      const lineIds = lines.map(() => newId());
      await db.transaction((tx) =>
        platform.events.publish(
          {
            type: 'goods.received',
            payload: {
              grnId,
              grnNumber: `GRN-2026-${String(++keyCounter).padStart(4, '0')}`,
              poId: newId(),
              lines: lines.map((line, index) => ({
                grnLineId: lineIds[index],
                itemId: line.itemId,
                quantity: line.quantity,
                unitCost: line.unitCost,
                costCodeId: codes['100'],
              })),
              destinationType: 'store',
              storeId,
              projectId: null,
              ownership: 'company',
            },
          },
          tx,
        ),
      );
      await platform.events.dispatchDue(db);
      return { grnId, lineIds };
    },

    issue(over, projectId) {
      return db.transaction((tx) =>
        inventory.issueToCostObject(
          {
            businessDate: '2026-10-25',
            costObject: { type: 'project', id: projectId },
            ...over,
          },
          actorFor(STOREKEEPER),
          tx,
        ),
      );
    },

    stock: (storeId, itemId) => inventory.getStockOnHand(db, storeId, itemId, 'company', null),

    async costs(projectId) {
      const page = await projects.costing.listEntries(
        db,
        { type: 'project', id: projectId },
        { limit: 200, offset: 0 },
      );
      return [...page.items].reverse().map((entry) => ({
        status: entry.status,
        amount: entry.amount,
        sourceDocType: entry.sourceDocType,
        reverses: entry.reversesEntryId !== null,
      }));
    },

    async setting(key, value) {
      const current = await db.query<{ version: number }>(
        'select version from sys_settings where key = $1',
        [key],
      );
      await db.transaction((tx) =>
        platform.settings.set(
          { key, value, expectedVersion: current[0]?.version ?? 0 },
          { actorUserId: null, requestId: null },
          tx,
        ),
      );
    },

    async activatePolicy(method) {
      const id = await db.transaction(
        async (tx) =>
          (
            await valuation.setPolicy(
              { scope: 'company', method, effectiveFrom: '2026-10-25' },
              { userId: ACCOUNTANT, requestId: null },
              tx,
            )
          ).id,
      );
      await kit.decide('valuation_policy', id, 'approve');
    },

    async decide(docType, id, action) {
      const state = await approvals.getApprovalState(db, docType, id);
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

    async notificationCount(template) {
      const rows = await db.query<{ n: string }>(
        'select count(*) as n from ntf_notifications where template = $1',
        [template],
      );
      return Number(rows[0]?.n ?? 0);
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
