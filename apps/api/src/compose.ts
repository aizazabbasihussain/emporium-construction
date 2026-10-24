import { connect } from '@emporium/db';
import { createPlatform, uuidv7 } from './modules/platform/index.js';
import { createIdentity, createJwtVerifier, type Identity } from './modules/identity/index.js';
import { createImporter, type Importer } from './modules/importer/index.js';
import { identityPermissions, importerPermissions, platformPermissions } from '@emporium/shared';
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

export interface Runtime {
  db: Db;
  identity: Identity;
  importer: Importer;
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
  const importer = createImporter({ platform, clock, newId: () => uuidv7(clock.now()) });
  if (config.adminEmail !== undefined) {
    const email = config.adminEmail;
    await db.transaction((tx) => identity.users.ensureAdmin(email, tx));
  }
  return { db, identity, importer, platform, close };
}
