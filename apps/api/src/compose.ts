import { connect } from '@emporium/db';
import { createPlatform, uuidv7 } from './modules/platform/index.js';
import {
  createIdentity,
  createJwtVerifier,
  currentUser,
  type Identity,
} from './modules/identity/index.js';
import { createApprovals, type Approvals } from './modules/approvals/index.js';
import {
  createFileStore,
  createFiles,
  type Files,
  type LocalFileStore,
} from './modules/files/index.js';
import {
  createNotifications,
  type Notifications,
  type UserDirectory,
} from './modules/notifications/index.js';
import { createImporter, type Importer } from './modules/importer/index.js';
import { createCrm, type Crm } from './modules/crm/index.js';
import { createEstimation, type Estimation } from './modules/estimation/index.js';
import { createMasterData, type MasterData } from './modules/masterdata/index.js';
import { createProjects, type Projects } from './modules/projects/index.js';
import { createQuotations, type Quotations } from './modules/quotations/index.js';
import { createDpr, type Dpr } from './modules/dpr/index.js';
import { createWorkforce, type Workforce } from './modules/workforce/index.js';
import { createAttendance, type Attendance } from './modules/attendance/index.js';
import { createWages, type Wages } from './modules/wages/index.js';
import { createPayroll, type Payroll } from './modules/payroll/index.js';
import {
  createWorkerPortal,
  ensureWorkerRole,
  type WorkerPortal,
} from './modules/workerportal/index.js';
import { createExpenses, type Expenses } from './modules/expenses/index.js';
import { createInventory, type Inventory } from './modules/inventory/index.js';
import { createProcurement, type Procurement } from './modules/procurement/index.js';
import { createVariations, type Variations } from './modules/variations/index.js';
import { createBilling, type Billing } from './modules/billing/index.js';
import { createCashbook, type Cashbook } from './modules/cashbook/index.js';
import { createReceivables, type Receivables } from './modules/receivables/index.js';
import { createPayables, type Payables } from './modules/payables/index.js';
import { createSubcontracts, type Subcontracts } from './modules/subcontracts/index.js';
import { createValuation, type Valuation } from './modules/valuation/index.js';
import { createTax, type Tax } from './modules/tax/index.js';
import { createReports, type Reports } from './modules/reports/index.js';
import { createProfitability, type Profitability } from './modules/profitability/index.js';
import { createAccounting, type Accounting } from './modules/accounting-exports/index.js';
import {
  approvalsPermissions,
  crmPermissions,
  dprPermissions,
  estimationPermissions,
  expensesPermissions,
  filesPermissions,
  workforcePermissions,
  attendancePermissions,
  identityPermissions,
  importerPermissions,
  masterdataPermissions,
  notificationsPermissions,
  platformPermissions,
  inventoryPermissions,
  payablesPermissions,
  payrollPermissions,
  subcontractsPermissions,
  procurementPermissions,
  projectsPermissions,
  quotationsPermissions,
  receivablesPermissions,
  profitabilityPermissions,
  accountingPermissions,
  reportsPermissions,
  taxPermissions,
  valuationPermissions,
  variationsPermissions,
  billingPermissions,
  cashbookPermissions,
  wagesPermissions,
  workerportalPermissions,
} from '@emporium/shared';
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet } from 'jose';
import type { AppConfig } from './config.js';
import type { Db } from './modules/platform/index.js';

const AUDIENCE = 'authenticated';

/** Token verification from configuration: a JWKS URL when set, otherwise the legacy JWT secret. */
export function verifierFor(config: Pick<AppConfig, 'supabaseJwksUrl' | 'supabaseJwtSecret'>) {
  const key = config.supabaseJwksUrl
    ? createRemoteJWKSet(new URL(config.supabaseJwksUrl))
    : new TextEncoder().encode(config.supabaseJwtSecret ?? '');
  return createJwtVerifier({ key, audience: AUDIENCE, now: () => new Date() });
}

/** Lets notifications find the holders of a role without importing identity internals. */
export function identityDirectory(identity: Pick<Identity, 'users'>): UserDirectory {
  return {
    async usersWithRole(db, roleCode) {
      return (await identity.users.list(db))
        .filter((user) => user.status === 'active' && user.roles.includes(roleCode))
        .map((user) => ({ id: user.id, roles: user.roles, scopes: user.scopes }));
    },
  };
}

export interface Runtime {
  db: Db;
  identity: Identity;
  importer: Importer;
  masterData: MasterData;
  crm: Crm;
  valuation: Valuation;
  tax: Tax;
  estimation: Estimation;
  quotations: Quotations;
  projects: Projects;
  variations: Variations;
  billing: Billing;
  cashbook: Cashbook;
  receivables: Receivables;
  payables: Payables;
  subcontracts: Subcontracts;
  procurement: Procurement;
  inventory: Inventory;
  expenses: Expenses;
  dpr: Dpr;
  workforce: Workforce;
  attendance: Attendance;
  wages: Wages;
  payroll: Payroll;
  workerPortal: WorkerPortal;
  reports: Reports;
  profitability: Profitability;
  accounting: Accounting;
  approvals: Approvals;
  files: Files;
  /** Set when FILE_STORE_DRIVER=local: it serves its own signed download links. */
  localFileStore: LocalFileStore | undefined;
  notifications: Notifications;
  platform: ReturnType<typeof createPlatform>;
  close: () => Promise<void>;
}

/** Wires the modules for the running process; each module registers the permissions it owns. */
export async function createRuntime(config: AppConfig): Promise<Runtime> {
  const { db, close } = connect(config.databaseUrl);
  return wireRuntime(db, close, config);
}

/** The wiring behind `createRuntime`, for any database (the acceptance suite passes PGlite). */
export async function wireRuntime(
  db: Db,
  close: () => Promise<void>,
  config: AppConfig,
  clock: { now: () => Date } = { now: () => new Date() },
): Promise<Runtime> {
  const platform = createPlatform({ clock });
  const identity = createIdentity({
    platform,
    verifier: verifierFor(config),
    newId: () => uuidv7(clock.now()),
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('importer', Object.values(importerPermissions));
  identity.registerPermissions('approvals', Object.values(approvalsPermissions));
  identity.registerPermissions('files', Object.values(filesPermissions));
  identity.registerPermissions('notifications', Object.values(notificationsPermissions));
  identity.registerPermissions('master', Object.values(masterdataPermissions));
  identity.registerPermissions('crm', Object.values(crmPermissions));
  identity.registerPermissions('valuation', Object.values(valuationPermissions));
  identity.registerPermissions('tax', Object.values(taxPermissions));
  identity.registerPermissions('estimation', Object.values(estimationPermissions));
  identity.registerPermissions('quotations', Object.values(quotationsPermissions));
  identity.registerPermissions('projects', Object.values(projectsPermissions));
  identity.registerPermissions('variations', Object.values(variationsPermissions));
  identity.registerPermissions('billing', Object.values(billingPermissions));
  identity.registerPermissions('cashbook', Object.values(cashbookPermissions));
  identity.registerPermissions('receivables', Object.values(receivablesPermissions));
  identity.registerPermissions('payables', Object.values(payablesPermissions));
  identity.registerPermissions('subcontracts', Object.values(subcontractsPermissions));
  identity.registerPermissions('procurement', Object.values(procurementPermissions));
  identity.registerPermissions('inventory', Object.values(inventoryPermissions));
  identity.registerPermissions('expenses', Object.values(expensesPermissions));
  identity.registerPermissions('dpr', Object.values(dprPermissions));
  identity.registerPermissions('workforce', Object.values(workforcePermissions));
  identity.registerPermissions('attendance', Object.values(attendancePermissions));
  identity.registerPermissions('wages', Object.values(wagesPermissions));
  identity.registerPermissions('payroll', Object.values(payrollPermissions));
  identity.registerPermissions('reports', Object.values(reportsPermissions));
  identity.registerPermissions('profitability', Object.values(profitabilityPermissions));
  identity.registerPermissions('accounting', Object.values(accountingPermissions));
  identity.registerPermissions('workerportal', Object.values(workerportalPermissions));
  await ensureWorkerRole(identity, db);
  const importer = createImporter({ platform, clock, newId: () => uuidv7(clock.now()) });
  const masterData = createMasterData({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    registerImporter: (definition) => importer.registerImporter(definition),
  });
  const approvals = createApprovals({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    roleCodes: async (tx) => (await identity.roles.list(tx)).map((role) => role.code),
  });
  const { store, local } = createFileStore(
    {
      driver: config.fileStoreDriver,
      local:
        config.fileStoreLocalDir !== undefined && config.fileUrlSecret !== undefined
          ? {
              directory: config.fileStoreLocalDir,
              secret: config.fileUrlSecret,
              baseUrl: config.publicApiUrl ?? '',
            }
          : undefined,
      supabase:
        config.supabaseUrl !== undefined &&
        config.supabaseServiceKey !== undefined &&
        config.supabaseStorageBucket !== undefined
          ? {
              url: config.supabaseUrl,
              serviceKey: config.supabaseServiceKey,
              bucket: config.supabaseStorageBucket,
            }
          : undefined,
    },
    clock.now,
  );
  const files = createFiles({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    newKey: randomUUID,
    store,
  });
  const notifications = createNotifications({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    directory: identityDirectory(identity),
    getApprovalState: approvals.getApprovalState,
  });
  const crm = createCrm({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    masterData,
    notifications,
    files,
  });
  const valuation = createValuation({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    masterData,
    approvals,
  });
  const tax = createTax({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    masterData,
    approvals,
  });
  const estimation = createEstimation({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    masterData,
  });
  const quotations = createQuotations({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    estimation,
    approvals,
    crm,
    masterData,
    files,
  });
  const projects = createProjects({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    allowGovernmentData: config.allowGovernmentData,
    masterData,
    identity,
    quotations,
    estimation,
  });
  const variations = createVariations({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    approvals,
    masterData,
    files,
  });
  const billing = createBilling({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    variations,
    quotations,
    tax,
    approvals,
    masterData,
  });
  const cashbook = createCashbook({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    approvals,
  });
  const receivables = createReceivables({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    cashbook,
    billing,
    approvals,
    notifications,
    masterData,
    projects,
  });
  const inventory = createInventory({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    valuation,
    projects,
    masterData,
    approvals,
    notifications,
  });
  // Payables needs procurement and procurement asks payables whether a receipt was billed, so
  // procurement receives a delegate that is filled in once payables exists.
  const latePayables: { current?: Payables } = {};
  const procurement = createProcurement({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    approvals,
    masterData,
    files,
    // BR-8: a receipt whose stock has left the store, or that a bill refers to, cannot be cancelled.
    guards: {
      isIssued: (db, grnId) => inventory.hasIssuesFromGrn(db, grnId),
      isBilled: (db, grnId) => (latePayables.current as Payables).isGrnBilled(db, grnId),
    },
  });
  const payables = createPayables({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    procurement,
    inventory,
    projects,
    tax,
    cashbook,
    approvals,
    masterData,
  });
  latePayables.current = payables;
  const subcontracts = createSubcontracts({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    masterData,
    approvals,
    payables,
  });
  const expenses = createExpenses({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    approvals,
    masterData,
    files,
    identity,
  });
  const dpr = createDpr({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    files,
    notifications,
  });
  // Workforce asks attendance about unapproved sheets and attendance asks workforce for teams, so
  // workforce receives a delegate that is filled in once attendance exists.
  const lateAttendance: { current?: Attendance } = {};
  const lateWages: { current?: Wages } = {};
  const workforce = createWorkforce({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    identity,
    masterData,
    attendance: {
      listUnapprovedSheets: (tx, workerId, upTo) =>
        (lateAttendance.current as Attendance).listUnapprovedSheets(tx, workerId, upTo),
    },
    registerImporter: (definition) => importer.registerImporter(definition),
  });
  const attendance = createAttendance({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    approvals,
    masterData,
    workforce,
    // BR-7: attendance asks wages whether the month of a sheet is approved.
    wages: {
      approvedPeriodOf: (tx, date) => (lateWages.current as Wages).approvedPeriodOf(tx, date),
    },
  });
  lateAttendance.current = attendance;
  const latePayroll: { current?: Payroll } = {};
  const wages = createWages({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    approvals,
    workforce,
    attendance,
    // P1-18 BR-11: wages asks payroll whether a run (finalized or paid) locks the period.
    payments: {
      hasPaidLines: (tx, periodId) => (latePayroll.current as Payroll).hasPaidLines(tx, periodId),
    },
  });
  lateWages.current = wages;
  const payroll = createPayroll({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    wages,
    attendance,
    projects,
    cashbook,
    approvals,
    masterData,
  });
  latePayroll.current = payroll;
  const workerPortal = createWorkerPortal({
    platform,
    clock,
    identity,
    workforce,
    attendance,
    wages,
  });
  const reports = createReports({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    procurement,
    inventory,
    attendance,
    crm,
    dpr,
    masterData,
  });
  const profitability = createProfitability({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    variations,
    billing,
    receivables,
    payables,
    payroll,
    expenses,
    notifications,
  });
  const accounting = createAccounting({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    files,
    billing,
    payables,
    receivables,
    cashbook,
    payroll,
    valuation,
    subcontracts,
    profitability,
    projects,
    expenses,
    masterData,
    tax,
  });
  if (config.adminEmail !== undefined) {
    const email = config.adminEmail;
    await db.transaction((tx) => identity.users.ensureAdmin(email, tx));
  }
  return {
    db,
    identity,
    importer,
    masterData,
    crm,
    valuation,
    tax,
    estimation,
    quotations,
    projects,
    variations,
    billing,
    cashbook,
    receivables,
    payables,
    subcontracts,
    procurement,
    inventory,
    expenses,
    dpr,
    workforce,
    attendance,
    wages,
    payroll,
    workerPortal,
    reports,
    profitability,
    accounting,
    approvals,
    files,
    localFileStore: local,
    notifications,
    platform,
    close,
  };
}

/** The route dependencies of every module for a wired runtime (shared by `main.ts` and the acceptance suite). */
export function routeDeps(runtime: Runtime) {
  const { db, platform } = runtime;
  return {
    identity: { db, identity: runtime.identity },
    platform: { db, platform, resolvePrincipal: currentUser },
    importer: { db, importer: runtime.importer },
    approvals: { db, approvals: runtime.approvals, platform },
    files: { db, files: runtime.files, platform, local: runtime.localFileStore },
    notifications: { db, notifications: runtime.notifications, platform },
    masterData: { db, masterData: runtime.masterData, platform },
    crm: { db, crm: runtime.crm, platform },
    valuation: { db, valuation: runtime.valuation, platform },
    tax: { db, tax: runtime.tax, platform },
    estimation: { db, estimation: runtime.estimation, platform },
    quotations: { db, quotations: runtime.quotations, platform },
    projects: { db, projects: runtime.projects, platform },
    variations: { db, variations: runtime.variations, platform },
    billing: { db, billing: runtime.billing, platform },
    cashbook: { db, cashbook: runtime.cashbook, platform },
    receivables: { db, receivables: runtime.receivables, platform },
    payables: { db, payables: runtime.payables, platform },
    subcontracts: { db, subcontracts: runtime.subcontracts, platform },
    procurement: { db, procurement: runtime.procurement, platform },
    inventory: { db, inventory: runtime.inventory, platform },
    expenses: { db, expenses: runtime.expenses, platform },
    dpr: { db, dpr: runtime.dpr, platform },
    workforce: { db, workforce: runtime.workforce, platform },
    attendance: { db, attendance: runtime.attendance, platform },
    wages: { db, wages: runtime.wages, platform },
    payroll: { db, payroll: runtime.payroll, platform },
    workerPortal: { db, workerPortal: runtime.workerPortal, platform },
    reports: { db, reports: runtime.reports.service, platform },
    profitability: { db, profitability: runtime.profitability.service, platform },
    accounting: {
      db,
      exports: runtime.accounting.exports,
      tagging: runtime.accounting.tagging,
      platform,
    },
  };
}
