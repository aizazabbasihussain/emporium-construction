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
import {
  approvalsPermissions,
  filesPermissions,
  identityPermissions,
  importerPermissions,
  notificationsPermissions,
  platformPermissions,
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
  const importer = createImporter({ platform, clock, newId: () => uuidv7(clock.now()) });
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
  if (config.adminEmail !== undefined) {
    const email = config.adminEmail;
    await db.transaction((tx) => identity.users.ensureAdmin(email, tx));
  }
  return {
    db,
    identity,
    importer,
    approvals,
    files,
    localFileStore: local,
    notifications,
    platform,
    close,
  };
}
