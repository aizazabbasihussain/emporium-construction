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
  procurementPermissions,
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
import { createProcurement, type Procurement } from './index.js';
import type { GrnInput } from './service/receipts.service.js';
import type { PoInput } from './service/orders.service.js';
import type { RequisitionInput } from './service/requisitions.service.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('procurement-test-secret-procurement-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-7777-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const PROCUREMENT = uid(4);
export const STOREKEEPER = uid(5);
export const SUPERVISOR = uid(6);
export const SUPERVISOR2 = uid(7);
export const NOBODY = uid(8);
export const STORE = uid(900);
export const MISSING = uid(999);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [PROCUREMENT, 'procurement@example.test', 'procurement'],
  [STOREKEEPER, 'storekeeper@example.test', 'storekeeper'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [SUPERVISOR2, 'supervisor2@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

export const PDF_BYTES = Uint8Array.from(
  [...'%PDF-1.7 delivery challan'].map((c) => c.charCodeAt(0)),
);
export const PHOTO = { fileName: 'challan.pdf', bytes: PDF_BYTES };

export interface LedgerRow {
  status: string;
  amount: string;
  sourceDocType: string;
  sourceLineId: string | null;
  reverses: boolean;
}

export interface ProcurementKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  files: Files;
  projects: Projects;
  procurement: Procurement;
  app: FastifyInstance;
  now: { current: Date };
  codes: Record<string, string>;
  inactiveCode: string;
  /** What the fake inventory and payables report about a receipt (BR-8). */
  guards: { issued: Set<string>; billed: Set<string> };
  /** The procurement officer: holds every procurement permission. */
  actor: Actor;
  actorFor(userId: string, scopes?: Actor['scopes']): Actor;
  project(): Promise<{ id: string; code: string }>;
  assignSupervisor(projectId: string, userId: string): Promise<void>;
  vendor(over?: { roles?: string[]; name?: string }): Promise<string>;
  item(over?: { code?: string; active?: boolean; unitCode?: string }): Promise<string>;
  requisition(over?: Partial<RequisitionInput>): Promise<{ id: string; version: number }>;
  approvedRequisition(over?: Partial<RequisitionInput>): Promise<string>;
  draftPo(
    projectId: string | null,
    over?: Partial<PoInput>,
  ): Promise<{ id: string; version: number }>;
  /** Submitted and approved by management; the events are delivered. */
  approvedPo(projectId: string | null, over?: Partial<PoInput>): Promise<string>;
  receiptInput(
    poId: string,
    quantities: Record<number, string>,
    over?: Partial<GrnInput>,
  ): Promise<GrnInput>;
  receive(
    poId: string,
    quantities: Record<number, string>,
    over?: Partial<GrnInput>,
  ): Promise<string>;
  decide(docType: string, id: string, action: 'approve' | 'reject' | 'return'): Promise<void>;
  ledger(projectId: string): Promise<LedgerRow[]>;
  setting(key: string, value: string | boolean, expectedVersion?: number): Promise<void>;
  poVersion(id: string): Promise<number>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;

export async function createProcurementKit(): Promise<ProcurementKit> {
  const db = await createTestDb();
  const directory = await mkdtemp(path.join(tmpdir(), 'emporium-procurement-'));
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
  identity.registerPermissions('procurement', Object.values(procurementPermissions));
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
  const guards = { issued: new Set<string>(), billed: new Set<string>() };
  const procurement = createProcurement({
    platform,
    clock,
    newId,
    projects,
    approvals,
    masterData,
    files,
    guards: {
      isIssued: async (_db, grnId) => guards.issued.has(grnId),
      isBilled: async (_db, grnId) => guards.billed.has(grnId),
    },
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
    procurement: { db, procurement, platform },
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
      { code: '998', name: 'Retired synthetic code', kind: 'overhead', active: false },
      admin,
      tx,
    ),
  );

  const allPermissions = new Set<string>([
    ...Object.values(procurementPermissions),
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
  const actor = actorFor(PROCUREMENT);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  let itemSeq = 0;
  let vendorSeq = 0;

  const kit: ProcurementKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    files,
    projects,
    procurement,
    app,
    now,
    codes,
    inactiveCode: inactive.id,
    guards,
    actor,
    actorFor,

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

    async vendor(over = {}) {
      vendorSeq += 1;
      const party = await db.transaction((tx) =>
        masterData.parties.create(
          {
            name: over.name ?? `Synthetic Vendor ${vendorSeq}`,
            roles: over.roles ?? ['vendor'],
            city: 'Rawalpindi',
          },
          admin,
          tx,
        ),
      );
      return party.id;
    },

    async item(over = {}) {
      itemSeq += 1;
      const created = await db.transaction((tx) =>
        masterData.catalog.createItem(
          {
            code: over.code ?? `PRC-ITEM-${itemSeq}`,
            name: `Synthetic item ${itemSeq}`,
            unitCode: over.unitCode ?? 'bag',
            itemKind: 'material',
            defaultTaxKind: 'goods',
            active: over.active ?? true,
          },
          admin,
          tx,
        ),
      );
      return created.id;
    },

    async requisition(over = {}) {
      const input: RequisitionInput = {
        storeId: over.projectId === undefined ? STORE : undefined,
        note: 'Cement for the boundary wall',
        lines: [
          {
            itemId: await kit.item(),
            quantity: '100',
            costCodeId: codes['100'] as string,
            estimatedRate: '1200',
          },
          { itemId: await kit.item(), quantity: '40', costCodeId: codes['100'] as string },
        ],
        ...over,
      };
      const created = await db.transaction((tx) =>
        procurement.service.requisitions.create(input, actor, tx),
      );
      return { id: created.id, version: created.version };
    },

    async approvedRequisition(over = {}) {
      const { id, version } = await kit.requisition(over);
      await db.transaction((tx) => procurement.service.requisitions.submit(id, version, actor, tx));
      await kit.decide('requisition', id, 'approve');
      return id;
    },

    async draftPo(projectId, over = {}) {
      const itemId = await kit.item();
      const input: PoInput = {
        vendorId: await kit.vendor(),
        ...(projectId === null ? { storeId: STORE } : { projectId }),
        orderDate: '2026-10-25',
        expectedDate: '2026-11-01',
        terms: 'Delivery to site',
        lines: [
          { itemId, quantity: '100', rate: '1250.5000', costCodeId: codes['100'] as string },
          {
            itemId: await kit.item(),
            quantity: '10.5',
            rate: '99.9999',
            costCodeId: codes['100'] as string,
          },
        ],
        ...over,
      };
      const created = await db.transaction((tx) =>
        procurement.service.orders.create(input, actor, tx),
      );
      return { id: created.id, version: created.version };
    },

    async approvedPo(projectId, over = {}) {
      const { id, version } = await kit.draftPo(projectId, over);
      await db.transaction((tx) => procurement.service.orders.submit(id, version, actor, tx));
      await kit.decide('purchase_order', id, 'approve');
      return id;
    },

    async receiptInput(poId, quantities, over = {}) {
      const po = await procurement.getPurchaseOrder(db, poId);
      return {
        poId,
        receivedOn: '2026-10-26',
        deliveryNoteRef: 'DC-1',
        lines: po.lines
          .filter((line) => quantities[line.lineNo] !== undefined)
          .map((line) => ({ poLineId: line.id, acceptedQty: quantities[line.lineNo] as string })),
        photos: [PHOTO],
        ...over,
      };
    },

    async receive(poId, quantities, over = {}) {
      const input = await kit.receiptInput(poId, quantities, over);
      const grn = await db.transaction((tx) =>
        procurement.service.receipts.create(input, actorFor(STOREKEEPER), tx),
      );
      return grn.id;
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

    async ledger(projectId) {
      const page = await projects.costing.listEntries(
        db,
        { type: 'project', id: projectId },
        { limit: 200, offset: 0 },
      );
      return [...page.items].reverse().map((entry) => ({
        status: entry.status,
        amount: entry.amount,
        sourceDocType: entry.sourceDocType,
        sourceLineId: entry.sourceLineId,
        reverses: entry.reversesEntryId !== null,
      }));
    },

    async setting(key, value, expectedVersion = 0) {
      await db.transaction((tx) =>
        platform.settings.set(
          { key, value, expectedVersion },
          { actorUserId: null, requestId: null },
          tx,
        ),
      );
    },

    async poVersion(id) {
      return (await procurement.getPurchaseOrder(db, id)).version;
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
