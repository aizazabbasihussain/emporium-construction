import { createTestDb, type SqlDb } from '@emporium/db';
import {
  approvalsPermissions,
  cashbookPermissions,
  identityPermissions,
  masterdataPermissions,
  payablesPermissions,
  platformPermissions,
  projectsPermissions,
  subcontractsPermissionGrants,
  subcontractsPermissions,
  taxPermissions,
  type SubcontractsPermission,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createApprovals, type Approvals } from '../approvals/index.js';
import { createCashbook } from '../cashbook/index.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createMasterData, type MasterData } from '../masterdata/index.js';
import { createPayables, type BillDto, type Payables } from '../payables/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createProjects, type Projects } from '../projects/index.js';
import { createTax, type Tax } from '../tax/index.js';
import { createSubcontracts, type Subcontracts } from './index.js';
import type { BackChargeInput, CertificateInput } from './service/certificates.service.js';
import type { WorkOrderInput } from './service/work-orders.service.js';
import type { Actor, CertificateDto, WorkOrderDto } from './types.js';

// A module may not import another module's test support, so this kit builds what it needs itself:
// the kernel, master data, approvals, projects, the tax engine, the cash book and payables. Payables
// is real (the bill source registry is what is under test); procurement and inventory are not used.

const SECRET = new TextEncoder().encode('subcontracts-test-secret-subcontracts-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-8888-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const ACCOUNTANT = uid(4);
export const SUPERVISOR = uid(5);
export const NOBODY = uid(6);
/** A second project manager: the one who certifies what the first one drafted. */
export const PM2 = uid(30);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [PM2, 'pm2@example.test', 'project_manager'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

/** The date of the kit. */
export const TODAY = '2026-10-25';
const FROM = '2026-01-01';

type Tx = Parameters<Parameters<SqlDb['transaction']>[0]>[0];
type PaymentInput = Parameters<Payables['payments']['create']>[0];
type PaymentDto = Awaited<ReturnType<Payables['payments']['get']>>;

export interface LedgerRow {
  status: string;
  amount: string;
  sourceDocType: string;
  reverses: boolean;
}

export interface SubcontractsKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  masterData: MasterData;
  approvals: Approvals;
  projects: Projects;
  tax: Tax;
  payables: Payables;
  subcontracts: Subcontracts;
  sapp: FastifyInstance;
  now: { current: Date };
  /** Cost codes by H-25 code: 100 materials, 300 subcontractors. */
  codes: Record<string, string>;
  /** A synthetic cost code that has been switched off. */
  inactiveCode: string;
  /** The project manager who drafts and submits; holds the permissions of the role. */
  pm: Actor;
  /** The owner, who approves orders and variations. */
  owner: Actor;
  /** The accountant: bills certificates and pays the bills. */
  acct: Actor;
  /** The accountant as payables sees them (every payables and cash book permission). */
  pactor: Actor;
  actorFor(userId: string): Actor;
  /** A supervisor of the given projects: sees orders, drafts certificates, sees no amounts. */
  supervisorOf(projectIds: string[]): Actor;
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** An active project in Islamabad (so the tax authority of a bill resolves). */
  locatedProject(): Promise<{ id: string }>;
  /** An active project without a location. */
  project(): Promise<{ id: string }>;
  assignSupervisor(projectId: string, userId: string): Promise<void>;
  /** An active party of master data (a subcontractor by default). */
  contractor(
    roles?: ('client' | 'vendor' | 'subcontractor' | 'labour_contractor')[],
  ): Promise<string>;
  vendor(): Promise<string>;
  /** The standard input: 1,000,000 for the project on cost code 300. */
  orderInput(projectId: string, partyId: string, over?: Partial<WorkOrderInput>): WorkOrderInput;
  /** A draft work order of a new active project. */
  draftOrder(over?: Partial<WorkOrderInput>): Promise<WorkOrderDto>;
  /** Submitted and approved by the owner; the commitment is on the cost ledger. */
  activeOrder(over?: Partial<WorkOrderInput>): Promise<WorkOrderDto>;
  order(id: string): Promise<WorkOrderDto>;
  /** A draft certificate at a cumulative percent (30 by default). */
  draftCertificate(orderId: string, over?: Partial<CertificateInput>): Promise<CertificateDto>;
  /** Submitted and approved by the second project manager; the cost entries are posted. */
  certified(orderId: string, over?: Partial<CertificateInput>): Promise<CertificateDto>;
  cert(id: string): Promise<CertificateDto>;
  backCharge(
    orderId: string,
    over?: Partial<BackChargeInput>,
  ): Promise<{ id: string; version: number }>;
  /** Decides as the owner (management role) and delivers the events. */
  decide(docType: string, id: string, action: 'approve' | 'reject' | 'return'): Promise<void>;
  decideAs(
    docType: string,
    id: string,
    userId: string,
    role: string,
    action?: 'approve' | 'reject' | 'return',
  ): Promise<void>;
  /** A bill built from a certified certificate, approved by the owner and posted. */
  postedBillOf(certificateId: string): Promise<BillDto>;
  /** A bank account of the cash book with money in it. */
  bank(opening?: string): Promise<string>;
  setThreshold(value: string): Promise<void>;
  /** A payment of posted bills, approved when it needs approval. */
  approvedPayment(input: PaymentInput): Promise<PaymentDto>;
  /** The cost ledger of a project, oldest first. */
  ledger(projectId: string): Promise<LedgerRow[]>;
  /** Committed, approved and posted totals of a project. */
  projectTotals(
    projectId: string,
  ): Promise<{ committed: string; approved: string; posted: string }>;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

const permissionsOfRole = (role: string): ReadonlySet<string> =>
  new Set(
    (Object.keys(subcontractsPermissionGrants) as SubcontractsPermission[]).filter((permission) =>
      subcontractsPermissionGrants[permission].includes(role),
    ),
  );

let counter = 0;

export async function createSubcontractsKit(): Promise<SubcontractsKit> {
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
  identity.registerPermissions('approvals', Object.values(approvalsPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('projects', Object.values(projectsPermissions));
  identity.registerPermissions('tax', Object.values(taxPermissions));
  identity.registerPermissions('cashbook', Object.values(cashbookPermissions));
  identity.registerPermissions('payables', Object.values(payablesPermissions));
  identity.registerPermissions('subcontracts', Object.values(subcontractsPermissions));
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
  const tax = createTax({ platform, clock, newId, masterData, approvals });
  const cashbook = createCashbook({ platform, clock, newId, approvals });
  const unused = async (): Promise<never> => {
    throw new Error('Subcontract bills never read orders or receipts');
  };
  const payables = createPayables({
    platform,
    clock,
    newId,
    procurement: { getGrn: unused, getPurchaseOrder: unused, listOpenPoLines: async () => [] },
    inventory: { hasIssuesFromGrn: async () => false },
    projects,
    tax,
    cashbook,
    approvals,
    masterData,
  });
  const subcontracts = createSubcontracts({
    platform,
    clock,
    newId,
    projects,
    masterData,
    approvals,
    payables,
  });

  for (const [id, email, role] of USERS) {
    await db.query(
      'insert into sys_users (id, auth_subject, email, full_name) values ($1, $2, $2, $2)',
      [id, email],
    );
    await db.query('insert into sys_user_roles (user_id, role_code) values ($1, $2)', [id, role]);
  }

  const sapp = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => now.current,
    identity: { db, identity },
    subcontracts: { db, subcontracts, platform },
  });
  await sapp.ready();

  const run: SubcontractsKit['run'] = (fn) => db.transaction(fn);
  const admin = { userId: ADMIN, requestId: null };
  const accountant = { userId: ACCOUNTANT, requestId: null };
  const seeded = await masterData.costing.listCostCodes(db);
  const codes = Object.fromEntries(seeded.map((code) => [code.code, code.id]));
  const inactive = await run((tx) =>
    masterData.costing.createCostCode(
      { code: '998', name: 'Retired synthetic code', kind: 'overhead', active: false },
      admin,
      tx,
    ),
  );
  const islamabad = await run((tx) =>
    masterData.company.createLocation(
      { name: 'Site Islamabad', region: 'islamabad', city: 'Islamabad' },
      admin,
      tx,
    ),
  );
  await run((tx) =>
    masterData.company.createRegistration(
      {
        authority: 'FBR',
        registrationType: 'strn',
        number: 'TEST-FBR-0001',
        validFrom: '2020-01-01',
      },
      admin,
      tx,
    ),
  );

  const actorOf = (userId: string, role: string, scopes: Actor['scopes'] = []): Actor => ({
    userId,
    roles: [role],
    scopes,
    permissions: permissionsOfRole(role),
    requestId: null,
  });
  const pm = actorOf(PM, 'project_manager');
  const owner = actorOf(MANAGEMENT, 'management');
  const pactor: Actor = {
    userId: ACCOUNTANT,
    roles: ['accountant'],
    scopes: [],
    permissions: new Set([
      ...Object.values(payablesPermissions),
      ...Object.values(cashbookPermissions),
    ]),
    requestId: null,
  };
  const acct: Actor = {
    ...actorOf(ACCOUNTANT, 'accountant'),
    permissions: new Set([...permissionsOfRole('accountant'), ...pactor.permissions]),
  };
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;
  let partySeq = 0;
  let clientSeq = 0;
  let accountSeq = 0;
  let invoiceSeq = 0;
  let ruleReady = false;

  const makeProject = async (located: boolean) => {
    clientSeq += 1;
    const clientParty = await run((tx) =>
      masterData.parties.create(
        { name: `Synthetic Client ${clientSeq}`, roles: ['client'], city: 'Lahore' },
        admin,
        tx,
      ),
    );
    const manager = actorOf(PM, 'project_manager');
    const created = await run((tx) =>
      projects.service.create(
        {
          name: 'Synthetic boundary wall',
          partyId: clientParty.id,
          sector: 'private',
          originalContractValue: '5000000',
          ...(located ? { locationId: islamabad.id } : {}),
        },
        manager,
        tx,
      ),
    );
    const active = await run((tx) =>
      projects.service.transition(created.id, 'active', created.version, manager, tx),
    );
    return { id: active.id };
  };

  const decideAs: SubcontractsKit['decideAs'] = async (
    docType,
    id,
    userId,
    role,
    action = 'approve',
  ) => {
    const state = await approvals.getApprovalState(db, docType, id);
    if (state.status === 'none') throw new Error('no approval request');
    await run((tx) =>
      approvals.service.act(
        state.id,
        action,
        { comment: action === 'approve' ? null : 'Not now' },
        { userId, roles: [role], scopes: [], requestId: null },
        tx,
      ),
    );
    await platform.events.dispatchDue(db);
  };

  const put = async (key: string, value: string | boolean) => {
    const current = await db.query<{ version: number }>(
      'select version from sys_settings where key = $1',
      [key],
    );
    await run((tx) =>
      platform.settings.set(
        { key, value, expectedVersion: current[0]?.version ?? 0 },
        { actorUserId: null, requestId: null },
        tx,
      ),
    );
  };

  // The tax engine needs the region map and a sales tax rule before a bill can be approved (H-02);
  // both are data entered by the accountant and approved by the owner, synthetic here.
  const approveRule = async (request: () => Promise<{ id: string }>) => {
    const rule = await request();
    await decideAs('tax_rule', rule.id, MANAGEMENT, 'management');
  };
  await approveRule(() =>
    run((tx) =>
      tax.rules.requestRegionEntry(
        { region: 'islamabad', supplyKind: 'services', authorityCode: 'FBR', effectiveFrom: FROM },
        accountant,
        tx,
      ),
    ),
  );
  await approveRule(() =>
    run((tx) =>
      tax.rules.requestSalesRule(
        {
          authorityCode: 'FBR',
          supplyKind: 'services',
          ratePercent: '10',
          taxCode: 'TEST-services',
          effectiveFrom: FROM,
        },
        accountant,
        tx,
      ),
    ),
  );

  const kit: SubcontractsKit = {
    db,
    platform,
    identity,
    masterData,
    approvals,
    projects,
    tax,
    payables,
    subcontracts,
    sapp,
    now,
    codes,
    inactiveCode: inactive.id,
    pm,
    owner,
    acct,
    pactor,
    actorFor: (userId) => actorOf(userId, USERS.find(([id]) => id === userId)?.[2] as string),
    supervisorOf: (projectIds) =>
      actorOf(
        SUPERVISOR,
        'supervisor',
        projectIds.map((id) => ({ type: 'project' as const, id })),
      ),
    run,

    async contractor(roles = ['subcontractor']) {
      partySeq += 1;
      const party = await run((tx) =>
        masterData.parties.create(
          { name: `Synthetic Subcontractor ${partySeq}`, roles, city: 'Attock' },
          admin,
          tx,
        ),
      );
      return party.id;
    },

    vendor: () => kit.contractor(['vendor']),

    project: () => makeProject(false),
    locatedProject: () => makeProject(true),

    async assignSupervisor(projectId, userId) {
      await run((tx) =>
        projects.service.setSupervisors(projectId, [{ userId }], kit.actorFor(PM), tx),
      );
    },

    orderInput(projectId, partyId, over = {}) {
      return {
        projectId,
        partyId,
        title: 'Brick work and plaster',
        scopeText: 'Boundary wall, 300 m',
        contractAmount: '1000000',
        costCodeId: codes['300'] as string,
        startDate: '2026-10-26',
        endDate: '2026-12-31',
        ...over,
      };
    },

    async draftOrder(over = {}) {
      const project = await kit.locatedProject();
      const partyId = await kit.contractor();
      return run((tx) =>
        subcontracts.orders.create(kit.orderInput(project.id, partyId, over), pm, tx),
      );
    },

    async activeOrder(over = {}) {
      const draft = await kit.draftOrder(over);
      await run((tx) => subcontracts.orders.submit(draft.id, draft.version, pm, tx));
      await kit.decide('subcontract_order', draft.id, 'approve');
      return kit.order(draft.id);
    },

    order: (id) => subcontracts.orders.get(db, id, owner),

    draftCertificate(orderId, over = {}) {
      const input: CertificateInput = {
        certificateDate: TODAY,
        basis: 'percent_complete',
        cumulativePercent: '30',
        ...over,
      };
      return run((tx) => subcontracts.certificates.create(orderId, input, pm, tx));
    },

    async certified(orderId, over = {}) {
      const draft = await kit.draftCertificate(orderId, over);
      await run((tx) => subcontracts.certificates.submit(draft.id, draft.version, pm, tx));
      await decideAs('subcontract_certificate', draft.id, PM2, 'project_manager');
      return kit.cert(draft.id);
    },

    cert: (id) => subcontracts.certificates.get(db, id, owner),

    backCharge(orderId, over = {}) {
      return run((tx) =>
        subcontracts.certificates.addBackCharge(
          orderId,
          { description: 'Rework of plaster', amount: '20000', ...over },
          pm,
          tx,
        ),
      );
    },

    decide: (docType, id, action) => decideAs(docType, id, MANAGEMENT, 'management', action),
    decideAs,

    async postedBillOf(certificateId) {
      if (!ruleReady) {
        // H-03: withholding on subcontractors is data entered by the accountant; synthetic here.
        await approveRule(() =>
          run((tx) =>
            tax.rules.requestWithholdingRule(
              {
                authorityCode: 'FBR',
                direction: 'we_withhold',
                partyType: 'subcontractor',
                nature: 'subcontract',
                ratePercent: '2',
                base: 'on_base',
                effectiveFrom: FROM,
              },
              accountant,
              tx,
            ),
          ),
        );
        ruleReady = true;
      }
      invoiceSeq += 1;
      const { bill } = await run((tx) =>
        subcontracts.certificates.bill(
          certificateId,
          { vendorInvoiceNo: `SUB-INV-${invoiceSeq}`, billDate: TODAY, dueDate: '2026-11-25' },
          acct,
          tx,
        ),
      );
      const matched = await run((tx) =>
        payables.bills.match(bill.id, { version: bill.version }, pactor, tx),
      );
      const submitted = await run((tx) =>
        payables.bills.submit(bill.id, matched.version, pactor, tx),
      );
      await kit.decide('vendor_bill', submitted.id, 'approve');
      const approved = await payables.bills.get(db, bill.id);
      return run((tx) => payables.bills.post(approved.id, approved.version, pactor, tx));
    },

    async bank(opening = '10000000') {
      accountSeq += 1;
      const account = await run((tx) =>
        cashbook.accounts.create(
          {
            code: `SUB-BANK-${accountSeq}`,
            name: `Subcontracts bank ${accountSeq}`,
            kind: 'bank',
            openingBalance: opening,
            openingDate: '2026-01-01',
          },
          pactor,
          tx,
        ),
      );
      return account.id;
    },

    setThreshold: (value) => put('cashbook.payment_approval_threshold', value),

    async approvedPayment(input) {
      const draft = await run((tx) => payables.payments.create(input, pactor, tx));
      const submitted = await run((tx) =>
        payables.payments.submit(draft.id, draft.version, pactor, tx),
      );
      if (submitted.status === 'pending_approval') {
        await kit.decide('payment', submitted.approvalDocId as string, 'approve');
      }
      return payables.payments.get(db, draft.id);
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
        reverses: entry.reversesEntryId !== null,
      }));
    },

    async projectTotals(projectId) {
      return (await projects.costing.getCostSummary(db, { type: 'project', id: projectId })).totals;
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
      await sapp.close();
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
