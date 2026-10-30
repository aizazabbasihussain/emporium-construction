import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type SqlDb } from '@emporium/db';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../app.js';
import { routeDeps, wireRuntime, type Runtime } from '../compose.js';
import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';

const SECRET = 'acceptance-secret-acceptance-secret';
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f9000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** One synthetic user per role of the pilot (BR-1 asks for 12 users across roles). */
export const PILOT_USERS = [
  { key: 'admin', n: 1, role: 'admin' },
  { key: 'owner', n: 2, role: 'management' },
  { key: 'owner2', n: 3, role: 'management' },
  { key: 'pm', n: 4, role: 'project_manager' },
  { key: 'estimator', n: 5, role: 'estimator' },
  { key: 'procurement', n: 6, role: 'procurement' },
  { key: 'storekeeper', n: 7, role: 'storekeeper' },
  { key: 'accountant', n: 8, role: 'accountant' },
  { key: 'supervisor', n: 9, role: 'supervisor' },
  { key: 'supervisor2', n: 10, role: 'supervisor' },
  { key: 'supervisor3', n: 11, role: 'supervisor' },
  { key: 'coordinator', n: 12, role: 'service_coordinator' },
] as const;

/** An authenticated user who holds no role; used to prove nothing is open by default. */
export const NOBODY = { key: 'nobody', n: 13, role: null } as const;

export type PilotUserKey = (typeof PILOT_USERS)[number]['key'] | typeof NOBODY.key;

export interface Response<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export interface Harness {
  db: SqlDb;
  runtime: Runtime;
  app: FastifyInstance;
  now: { current: Date };
  userId(key: PilotUserKey): string;
  /** A signed bearer token for a pilot user (for requests that are not JSON, such as uploads). */
  tokenFor(user: PilotUserKey): Promise<string>;
  /** A request as the given user; `body` is sent as JSON. */
  call<T = Record<string, unknown>>(
    user: PilotUserKey | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response<T>>;
  close(): Promise<void>;
}

export function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    logLevel: 'silent',
    databaseUrl: 'postgres://unused',
    supabaseJwksUrl: undefined,
    supabaseJwtSecret: SECRET,
    fileStoreDriver: 'local',
    allowGovernmentData: false,
    corsOrigins: [],
    adminEmail: undefined,
    fileStoreLocalDir: mkdtempSync(path.join(tmpdir(), 'emporium-gate-a-')),
    fileUrlSecret: 'acceptance-file-secret-0123456789',
    publicApiUrl: 'http://localhost:3000',
    supabaseUrl: undefined,
    supabaseServiceKey: undefined,
    supabaseStorageBucket: undefined,
  };
}

export async function createHarness(
  options: { db?: SqlDb; config?: Partial<AppConfig>; now?: Date } = {},
): Promise<Harness> {
  const db = options.db ?? (await createTestDb());
  const now = { current: options.now ?? new Date('2026-10-26T05:00:00Z') };
  const config = { ...testConfig(), ...options.config };
  const runtime = await wireRuntime(db, async () => undefined, config, {
    now: () => new Date(now.current),
  });
  for (const user of [...PILOT_USERS, NOBODY]) {
    await db.query(
      `insert into sys_users (id, auth_subject, email, full_name) values ($1, $2, $2, $3)
       on conflict do nothing`,
      [uid(user.n), `${user.key}@pilot.test`, `Pilot ${user.key}`],
    );
    if (user.role !== null) {
      await db.query(
        `insert into sys_user_roles (user_id, role_code) values ($1, $2) on conflict do nothing`,
        [uid(user.n), user.role],
      );
    }
  }
  const app = await buildApp({
    config,
    logger: createLogger('silent'),
    clock: () => new Date(now.current),
    ...routeDeps(runtime),
  });
  await app.ready();
  const key = new TextEncoder().encode(SECRET);
  const tokens = new Map<string, string>();
  const tokenFor = async (user: PilotUserKey) => {
    let token = tokens.get(user);
    if (token === undefined) {
      token = await new SignJWT({ email: `${user}@pilot.test` })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(`${user}@pilot.test`)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('12h')
        .sign(key);
      tokens.set(user, token);
    }
    return token;
  };
  return {
    db,
    runtime,
    app,
    now,
    tokenFor,
    userId: (userKey) => uid([...PILOT_USERS, NOBODY].find((u) => u.key === userKey)?.n ?? 0),
    async call(user, method, url, body, headers = {}) {
      const response = await app.inject({
        method,
        url,
        headers: {
          ...(user === null ? {} : { authorization: `Bearer ${await tokenFor(user)}` }),
          ...headers,
        },
        ...(body === undefined ? {} : { payload: body as object }),
      });
      const text = response.body;
      let parsed: unknown = text;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        // Non-JSON bodies (file downloads) are returned as text.
      }
      return { status: response.statusCode, body: parsed as never };
    },
    close: () => app.close(),
  };
}
