import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type SqlDb } from '@emporium/db';
import { filesPermissions, identityPermissions, platformPermissions } from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import {
  createFiles,
  type FileAccessCheck,
  type FileActor,
  type Files,
  type LocalFileStore,
} from './index.js';
import { createFilesService } from './service/files.service.js';
import type { FileStore } from './store/file-store.js';
import { createLocalFileStore } from './store/local.store.js';
import { createMemoryStorageClient } from './store/memory-storage-client.js';
import { createSupabaseFileStore } from './store/supabase.store.js';

const SECRET = new TextEncoder().encode('files-test-secret-files-test-secret-123');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7777-1111-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const PM = uid(2);
export const SUPERVISOR = uid(3);
export const ACCOUNTANT = uid(4);
export const NOBODY = uid(5);

export const EMAILS: Record<string, string> = {
  [ADMIN]: 'admin@example.test',
  [PM]: 'pm@example.test',
  [SUPERVISOR]: 'supervisor@example.test',
  [ACCOUNTANT]: 'accountant@example.test',
  [NOBODY]: 'nobody@example.test',
};

export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const PDF = Uint8Array.from([...'%PDF-1.7 hello'].map((ch) => ch.charCodeAt(0)));
export const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);

export interface FilesKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  files: Files;
  store: FileStore;
  local: LocalFileStore | undefined;
  /** The raw objects held by the in-memory Supabase client (undefined with the local driver). */
  objects: Map<string, unknown> | undefined;
  app: FastifyInstance;
  now: { current: Date };
  check: FileAccessCheck;
  /** Entity ids a user may use: `allow(entityId, userId...)`. */
  allow(entityId: string, ...userIds: string[]): void;
  entity(): string;
  token(userId: string): Promise<string>;
  actor(userId: string, permissions?: string[]): FileActor;
  close(): Promise<void>;
}

let counter = 0;
let entityCounter = 0;

/** `driver: 'local'` stores objects on disk and mounts the signed download route. */
export async function createFilesKit(driver: 'memory' | 'local' = 'memory'): Promise<FilesKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f8888-1111-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('files', Object.values(filesPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);

  const directory = driver === 'local' ? await mkdtemp(path.join(tmpdir(), 'emporium-kit-')) : '';
  const memory = createMemoryStorageClient(clock.now);
  const local =
    driver === 'local'
      ? createLocalFileStore({
          directory,
          secret: 'kit-secret-kit-secret-kit',
          baseUrl: 'https://api.example.test',
          now: clock.now,
        })
      : undefined;
  const store = local ?? createSupabaseFileStore(memory);
  const files = createFiles({ platform, clock, newId, newKey: randomUUID, store });

  const allowed = new Map<string, Set<string>>();
  const check: FileAccessCheck = ({ actor, entityId }) =>
    Promise.resolve(allowed.get(entityId)?.has(actor.userId) ?? false);
  files.registerFileAccess('test_doc', check);
  files.registerFileAccess('ledger_doc', check, { retainForever: true });

  for (const [id, role] of [
    [ADMIN, 'admin'],
    [PM, 'project_manager'],
    [SUPERVISOR, 'supervisor'],
    [ACCOUNTANT, 'accountant'],
    [NOBODY, 'nopower'],
  ] as const) {
    const email = EMAILS[id] as string;
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
    files: { db, files, platform, local },
  });
  await app.ready();

  return {
    db,
    platform,
    identity,
    files,
    store,
    local,
    objects: driver === 'memory' ? memory.objects : undefined,
    app,
    now,
    check,
    allow(entityId, ...userIds) {
      allowed.set(entityId, new Set(userIds));
    },
    entity: () => `018f9999-1111-7000-8000-${String(++entityCounter).padStart(12, '0')}`,
    token: (userId) =>
      new SignJWT({ email: EMAILS[userId] })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(EMAILS[userId] as string)
        .setAudience(AUDIENCE)
        .setIssuedAt(Math.floor(now.current.getTime() / 1000))
        .setExpirationTime(Math.floor(now.current.getTime() / 1000) + 3600)
        .sign(SECRET),
    actor: (userId, permissions = Object.values(filesPermissions)) => ({
      userId,
      roles: [],
      scopes: [],
      permissions: new Set(permissions),
      requestId: null,
    }),
    async close() {
      await app.close();
      if (directory !== '') await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A service over the kit's store, for tests that need to wrap the database or the store. */
export function serviceOf(kit: FilesKit, store: FileStore = kit.store) {
  const clock = { now: () => new Date(kit.now.current) };
  const service = createFilesService({
    platform: kit.platform,
    clock,
    newId: () => randomUUID(),
    newKey: randomUUID,
    store,
  });
  service.registerFileAccess('test_doc', kit.check);
  return service;
}

/** A multipart/form-data body for `app.inject`. */
export function multipartBody(
  fields: Record<string, string>,
  file?: { name: string; bytes: Uint8Array; type?: string },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----emporiumtest1234';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `content-type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      Buffer.from(file.bytes),
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** A database whose queries can be answered or failed by the test; everything else passes through. */
export function interceptQuery(
  db: SqlDb,
  intercept: (sql: string) => Promise<unknown[]> | undefined,
): SqlDb {
  return {
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    query: <T>(sql: string, params?: readonly unknown[]) =>
      (intercept(sql) ?? db.query<T>(sql, params)) as Promise<T[]>,
  };
}
