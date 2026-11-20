import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  billingPermissions,
  filesPermissions,
  identityPermissions,
  masterdataPermissions,
  platformPermissions,
  projectsPermissions,
  taxPermissions,
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
import { createProjects, type Projects } from '../projects/index.js';
import { createTax, type Tax } from '../tax/index.js';
import { createVariations, type Variations } from '../variations/index.js';
import {
  createBilling,
  type Billing,
  type InvoiceDto,
  type ScheduleDto,
} from '../billing/index.js';
import type { Actor } from './types.js';

type InvoiceInput = Parameters<Billing['invoices']['create']>[1];

const SECRET = new TextEncoder().encode('billing-test-secret-billing-test-secret-1');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-7777-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const ACCOUNTANT = uid(3);
export const PM = uid(4);
export const NOBODY = uid(5);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [PM, 'pm@example.test', 'project_manager'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

export const PDF_BYTES = Uint8Array.from(
  [...'%PDF-1.7 client approval letter'].map((c) => c.charCodeAt(0)),
);

/** Synthetic rates used by the tests only; they mean nothing. */
export const FBR_RATE = '10';
export const PRA_RATE = '16';
const FROM = '2026-01-01';

export interface BillingKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  files: Files;
  projects: Projects;
  variations: Variations;
  tax: Tax;
  billing: Billing;
  app: FastifyInstance;
  now: { current: Date };
  /** The accountant, who holds every billing permission. */
  actor: Actor;
  actorFor(userId: string, scopes?: Actor['scopes']): Actor;
  /** A scope-limited user who is assigned to no project the tests create. */
  outsider: Actor;
  tx<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
  /** The stages the stub quotation gives every project: 30%, 40%, 30%. */
  quotationStages: {
    stageNo: number;
    name: string;
    basis: 'percent';
    percent: string;
    amount: string;
  }[];
  /** An active project of the given contract value; `lahore` is taxed by PRA, `islamabad` by FBR. */
  project(options?: {
    where?: 'islamabad' | 'lahore' | 'none';
    value?: string;
    quotation?: boolean;
  }): Promise<{ id: string; code: string }>;
  schedule(projectId: string): Promise<ScheduleDto>;
  /** A draft invoice for the stage numbers of the project's schedule. */
  draft(projectId: string, stageNos: number[], over?: Partial<InvoiceInput>): Promise<InvoiceDto>;
  decide(docType: string, docId: string, action: 'approve' | 'reject' | 'return'): Promise<void>;
  /** Submitted and approved by management, events delivered. */
  approved(
    projectId: string,
    stageNos: number[],
    over?: Partial<InvoiceInput>,
  ): Promise<InvoiceDto>;
  /** The full path to an issued invoice. */
  issued(projectId: string, stageNos: number[], over?: Partial<InvoiceInput>): Promise<InvoiceDto>;
  /** An advance invoice issued and marked received (P2-04's call). */
  receivedAdvance(projectId: string, amount: string): Promise<string>;
  /** An approved variation of the project with the given price impact. */
  approvedVariation(projectId: string, priceImpact: string): Promise<string>;
  get(id: string): Promise<InvoiceDto>;
  setting(key: string, value: string | number | boolean): Promise<void>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;
let quotationCounter = 0;

export async function createBillingKit(options: { company?: boolean } = {}): Promise<BillingKit> {
  const db = await createTestDb();
  const directory = await mkdtemp(path.join(tmpdir(), 'emporium-billing-'));
  const now = { current: new Date('2026-11-18T10:00:00Z') };
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
  identity.registerPermissions('tax', Object.values(taxPermissions));
  identity.registerPermissions('projects', Object.values(projectsPermissions));
  identity.registerPermissions('variations', Object.values(variationsPermissions));
  identity.registerPermissions('billing', Object.values(billingPermissions));
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
  const quotationStages = [
    { stageNo: 1, name: 'Mobilization', basis: 'percent' as const, percent: '30', amount: '0' },
    { stageNo: 2, name: 'Structure', basis: 'percent' as const, percent: '40', amount: '0' },
    { stageNo: 3, name: 'Handover', basis: 'percent' as const, percent: '30', amount: '0' },
  ];
  const quotations = {
    getQuotation: async () => ({ title: 'Synthetic quotation', stages: quotationStages }) as never,
  };
  const tax = createTax({ platform, clock, newId, masterData, approvals });
  const projects = createProjects({
    platform,
    clock,
    newId,
    allowGovernmentData: false,
    masterData,
    identity,
    quotations,
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
  });
  const billing = createBilling({
    platform,
    clock,
    newId,
    projects,
    variations,
    quotations,
    tax,
    approvals,
    masterData,
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
    billing: { db, billing, platform },
  });
  await app.ready();

  const admin = { userId: ADMIN, requestId: null };
  const accountant = { userId: ACCOUNTANT, requestId: null };
  const management = { userId: MANAGEMENT, roles: ['management'], scopes: [], requestId: null };
  const decide: BillingKit['decide'] = async (docType, docId, action) => {
    const state = await approvals.getApprovalState(db, docType, docId);
    if (state.status === 'none') throw new Error('no approval request');
    await db.transaction((tx) =>
      approvals.service.act(
        state.id,
        action,
        { comment: action === 'approve' ? null : 'Not now' },
        management,
        tx,
      ),
    );
    await platform.events.dispatchDue(db);
  };

  // Locations, company registrations and synthetic tax rules: Islamabad is taxed by FBR, Punjab by PRA.
  const islamabad = await db.transaction((tx) =>
    masterData.company.createLocation(
      { name: 'Site Islamabad', region: 'islamabad', city: 'Islamabad' },
      admin,
      tx,
    ),
  );
  const lahore = await db.transaction((tx) =>
    masterData.company.createLocation(
      { name: 'Site Lahore', region: 'punjab', city: 'Lahore' },
      admin,
      tx,
    ),
  );
  for (const [authority, registrationType, number] of [
    ['FBR', 'strn', 'TEST-FBR-0001'],
    ['PRA', 'pra', 'TEST-PRA-0001'],
  ] as const) {
    await db.transaction((tx) =>
      masterData.company.createRegistration(
        { authority, registrationType, number, validFrom: '2020-01-01' },
        admin,
        tx,
      ),
    );
  }
  if (options.company !== false) {
    await db.transaction((tx) =>
      masterData.company.saveCompany(
        {
          name: 'Synthetic Builders',
          address: 'Office 1, Islamabad',
          phone: '051-0000000',
          email: 'accounts@example.test',
        },
        undefined,
        admin,
        tx,
      ),
    );
  }
  const approveRule = async (request: () => Promise<{ id: string }>) => {
    const rule = await request();
    await decide('tax_rule', rule.id, 'approve');
  };
  for (const [region, authorityCode] of [
    ['islamabad', 'FBR'],
    ['punjab', 'PRA'],
  ] as const) {
    await approveRule(() =>
      db.transaction((tx) =>
        tax.rules.requestRegionEntry(
          { region, supplyKind: 'services', authorityCode, effectiveFrom: FROM },
          accountant,
          tx,
        ),
      ),
    );
  }
  for (const [authorityCode, ratePercent] of [
    ['FBR', FBR_RATE],
    ['PRA', PRA_RATE],
  ] as const) {
    await approveRule(() =>
      db.transaction((tx) =>
        tax.rules.requestSalesRule(
          {
            authorityCode,
            supplyKind: 'services',
            ratePercent,
            taxCode: `TEST-${authorityCode}`,
            effectiveFrom: FROM,
          },
          accountant,
          tx,
        ),
      ),
    );
  }
  const client = await db.transaction((tx) =>
    masterData.parties.create(
      { name: 'Synthetic Client', roles: ['client'], city: 'Lahore', ntn: 'TEST-NTN-1' },
      admin,
      tx,
    ),
  );

  const allPermissions = new Set<string>([
    ...Object.values(billingPermissions),
    ...Object.values(projectsPermissions),
    ...Object.values(variationsPermissions),
    ...Object.values(filesPermissions),
  ]);
  const actorFor = (userId: string, scopes: Actor['scopes'] = []): Actor => ({
    userId,
    roles: USERS.filter(([id]) => id === userId).map(([, , role]) => role),
    scopes,
    permissions: allPermissions,
    requestId: null,
  });
  const actor = actorFor(ACCOUNTANT);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  const tx = <T>(fn: (t: SqlDb) => Promise<T>) => db.transaction(fn);

  const kit: BillingKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    files,
    projects,
    variations,
    tax,
    billing,
    app,
    now,
    actor,
    actorFor,
    outsider: {
      userId: PM,
      roles: ['supervisor'],
      scopes: [{ type: 'project', id: uid(7777) }],
      permissions: allPermissions,
      requestId: null,
    },
    tx,
    quotationStages,
    decide,

    async project(options = {}) {
      const where = options.where ?? 'islamabad';
      const quotationId = options.quotation === false ? null : uid(9000 + ++quotationCounter);
      const value = options.value ?? '5000000';
      const locationId = where === 'none' ? null : where === 'lahore' ? lahore.id : islamabad.id;
      const created =
        quotationId === null
          ? await tx((t) =>
              projects.service.create(
                {
                  name: 'Synthetic manual project',
                  partyId: client.id,
                  sector: 'private',
                  originalContractValue: value,
                  ...(locationId === null ? {} : { locationId }),
                },
                actor as never,
                t,
              ),
            )
          : await tx((t) =>
              projects.service.createFromQuotation(
                {
                  quotationId,
                  estimateId: uid(8000 + quotationCounter),
                  partyId: client.id,
                  sector: 'private',
                  locationId,
                  contractValue: value,
                },
                t,
              ),
            );
      const detail = await projects.service.get(db, created.id, actor);
      const active = await tx((t) =>
        projects.service.transition(created.id, 'active', detail.version, actor as never, t),
      );
      await platform.events.dispatchDue(db);
      return { id: active.id, code: active.code };
    },

    schedule: (projectId) => billing.schedule.get(db, projectId, actor),

    async draft(projectId, stageNos, over = {}) {
      const schedule = await billing.schedule.get(db, projectId, actor);
      const scheduleIds = stageNos.map(
        (no) => schedule.stages.find((stage) => stage.stageNo === no)?.id as string,
      );
      return tx((t) =>
        billing.invoices.create(
          projectId,
          { scheduleIds, invoiceDate: '2026-11-18', ...over },
          actor,
          t,
        ),
      );
    },

    async approved(projectId, stageNos, over = {}) {
      const draft = await kit.draft(projectId, stageNos, over);
      await tx((t) => billing.invoices.submit(draft.id, draft.version, actor, t));
      await decide('invoice', draft.id, 'approve');
      return kit.get(draft.id);
    },

    async issued(projectId, stageNos, over = {}) {
      const approved = await kit.approved(projectId, stageNos, over);
      return tx((t) => billing.invoices.issue(approved.id, approved.version, actor, t));
    },

    async receivedAdvance(projectId, amount) {
      const { advance, invoice } = await tx((t) =>
        billing.advances.request({ projectId, amount, invoiceDate: '2026-11-18' }, actor, t),
      );
      await tx((t) => billing.invoices.submit(invoice.id, invoice.version, actor, t));
      await decide('invoice', invoice.id, 'approve');
      const approved = await kit.get(invoice.id);
      await tx((t) => billing.invoices.issue(approved.id, approved.version, actor, t));
      await tx((t) =>
        billing.markAdvanceReceived(
          advance.id,
          '2026-11-18',
          { userId: ACCOUNTANT, requestId: null },
          t,
        ),
      );
      return advance.id;
    },

    async approvedVariation(projectId, priceImpact) {
      const costCodes = await masterData.costing.listCostCodes(db);
      const created = await tx((t) =>
        variations.service.create(
          projectId,
          {
            title: 'Extra work',
            discoveredOn: '2026-11-10',
            lines: [
              {
                description: 'Extra',
                costCodeId: (costCodes[0] as { id: string }).id,
                costAmount: '1.00',
                priceAmount: priceImpact,
              },
            ],
          },
          actor as never,
          t,
        ),
      );
      await tx((t) =>
        variations.service.submitInternal(created.id, created.version, actor as never, t),
      );
      await decide('variation', created.id, 'approve');
      await tx((t) =>
        variations.service.sendToClient(created.id, created.version + 1, actor as never, t),
      );
      await tx((t) =>
        files.attach(
          {
            entityType: 'var_variation',
            entityId: created.id,
            fileName: 'client.pdf',
            bytes: PDF_BYTES,
          },
          actor as never,
          t,
        ),
      );
      await tx((t) =>
        variations.service.clientApprove(
          created.id,
          { reference: 'CLIENT-LTR-1', approvedOn: '2026-11-17' },
          created.version + 2,
          actor as never,
          t,
        ),
      );
      await platform.events.dispatchDue(db);
      return created.id;
    },

    get: (id) => billing.invoices.get(db, id, actor),

    async setting(key, value) {
      const current = await platform.settings.get(db, key);
      await tx((t) =>
        platform.settings.set(
          { key, value, expectedVersion: current.version },
          { actorUserId: ADMIN, requestId: null },
          t,
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
