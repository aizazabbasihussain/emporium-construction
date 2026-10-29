import { connect } from '@emporium/db';
import { createPlatform, uuidv7 } from './modules/platform/index.js';
import { createIdentity, createJwtVerifier, type Identity } from './modules/identity/index.js';
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
import { createExpenses, type Expenses } from './modules/expenses/index.js';
import { createInventory, type Inventory } from './modules/inventory/index.js';
import { createProcurement, type Procurement } from './modules/procurement/index.js';
import { createVariations, type Variations } from './modules/variations/index.js';
import { createValuation, type Valuation } from './modules/valuation/index.js';
import {
  approvalsPermissions,
  crmPermissions,
  dprPermissions,
  estimationPermissions,
  expensesPermissions,
  filesPermissions,
  identityPermissions,
  importerPermissions,
  masterdataPermissions,
  notificationsPermissions,
  platformPermissions,
  inventoryPermissions,
  procurementPermissions,
  projectsPermissions,
  quotationsPermissions,
  valuationPermissions,
  variationsPermissions,
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
  estimation: Estimation;
  quotations: Quotations;
  projects: Projects;
  variations: Variations;
  procurement: Procurement;
  inventory: Inventory;
  expenses: Expenses;
  dpr: Dpr;
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
  const clock = { now: () => new Date() };
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
  identity.registerPermissions('estimation', Object.values(estimationPermissions));
  identity.registerPermissions('quotations', Object.values(quotationsPermissions));
  identity.registerPermissions('projects', Object.values(projectsPermissions));
  identity.registerPermissions('variations', Object.values(variationsPermissions));
  identity.registerPermissions('procurement', Object.values(procurementPermissions));
  identity.registerPermissions('inventory', Object.values(inventoryPermissions));
  identity.registerPermissions('expenses', Object.values(expensesPermissions));
  identity.registerPermissions('dpr', Object.values(dprPermissions));
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
  const procurement = createProcurement({
    platform,
    clock,
    newId: () => uuidv7(clock.now()),
    projects,
    approvals,
    masterData,
    files,
    // BR-8: a receipt whose stock has left the store cannot be cancelled. Payables (P2-05) will
    // answer the billed question; until then nothing is billed.
    guards: {
      isIssued: (db, grnId) => inventory.hasIssuesFromGrn(db, grnId),
      isBilled: async () => false,
    },
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
    estimation,
    quotations,
    projects,
    variations,
    procurement,
    inventory,
    expenses,
    dpr,
    approvals,
    files,
    localFileStore: local,
    notifications,
    platform,
    close,
  };
}
