import { createTestDb, type SqlDb } from '@emporium/db';
import type { ColumnDef } from '@emporium/domain/importer';
import { identityPermissions, importerPermissions, platformPermissions } from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createImporter, type Importer, type ImporterDefinition } from './index.js';

const SECRET = new TextEncoder().encode('importer-test-secret-importer-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f4444-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const ACCOUNTANT = uid(2);
export const MANAGER = uid(3);
export const STOREKEEPER = uid(4);

/** Columns of the test-only sample importer used by AC-1. */
export const personColumns: ColumnDef[] = [
  { name: 'Name', type: 'text', required: true, example: 'Test Person', maxLength: 50 },
  { name: 'Amount', type: 'decimal', required: true, example: '1250.50' },
  { name: 'Joined', type: 'date', required: false, example: '2026-01-15' },
  {
    name: 'Kind',
    type: 'enum',
    required: false,
    example: 'private',
    allowed: ['private', 'government'],
  },
];

export interface Person {
  Name: string;
  Amount: string;
  Joined: string | null;
  Kind: 'private' | 'government' | null;
}

const personSchema = z.object({
  Name: z.string(),
  Amount: z.string().refine((v) => Number(v) >= 0, 'Must not be negative'),
  Joined: z.string().nullable(),
  Kind: z.enum(['private', 'government']).nullable(),
});

export interface ImporterKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  importer: Importer;
  app: FastifyInstance;
  now: { current: Date };
  token(email: string): Promise<string>;
  /** Registers the sample importer; `apply` can be replaced to simulate failures. */
  registerPeople(over?: Partial<ImporterDefinition<Person>>): void;
  /** Registers `dependent`, which needs a committed `people` batch. */
  registerDependent(): void;
  /** Registers an importer whose `apply` is the given function (replaceable per test). */
  registerFailing(apply: ImporterDefinition['apply'], code?: string): void;
  close(): Promise<void>;
}

let counter = 0;

export async function createImporterKit(): Promise<ImporterKit> {
  const db = await createTestDb();
  await db.exec(`create table tst_people (
    name text not null, amount numeric(18,2) not null, joined date, kind text, batch_id uuid
  )`);
  const now = { current: new Date('2026-10-24T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f5555-0000-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('importer', Object.values(importerPermissions));
  const importer = createImporter({ platform, clock, newId });
  const behaviours = new Map<string, ImporterDefinition['apply']>();

  for (const [id, email, role] of [
    [ADMIN, 'admin@example.test', 'admin'],
    [ACCOUNTANT, 'accountant@example.test', 'accountant'],
    [MANAGER, 'manager@example.test', 'management'],
    [STOREKEEPER, 'storekeeper@example.test', 'storekeeper'],
  ] as const) {
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
    importer: { db, importer },
  });
  await app.ready();

  return {
    db,
    platform,
    identity,
    importer,
    app,
    now,
    token: (email) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(email)
        .setAudience(AUDIENCE)
        .setIssuedAt(Math.floor(now.current.getTime() / 1000))
        .setExpirationTime('1h')
        .sign(SECRET),
    registerDependent() {
      if (importer.registry.list().some((i) => i.code === 'dependent')) return;
      importer.registerImporter({
        code: 'dependent',
        label: 'Dependent (test)',
        schema: z.object({ Name: z.string() }),
        columns: [{ name: 'Name', type: 'text', required: true, example: 'x' }],
        dependsOn: ['people'],
        apply: () => Promise.resolve(),
      });
    },
    registerFailing(apply, code = 'failing') {
      behaviours.set(code, apply);
      if (importer.registry.list().some((i) => i.code === code)) return;
      importer.registerImporter({
        code,
        label: `${code} (test)`,
        schema: z.object({}).passthrough(),
        columns: personColumns,
        apply: (rows, ctx, tx) =>
          (behaviours.get(code) as ImporterDefinition['apply'])(rows, ctx, tx),
      });
    },
    registerPeople(over = {}) {
      if (importer.registry.list().some((i) => i.code === 'people')) return;
      importer.registerImporter<Person>({
        code: 'people',
        label: 'People (test)',
        schema: personSchema,
        columns: personColumns,
        async apply(rows, ctx, tx) {
          for (const row of rows) {
            await tx.query(
              'insert into tst_people (name, amount, joined, kind, batch_id) values ($1, $2, $3, $4, $5)',
              [row.Name, row.Amount, row.Joined, row.Kind, ctx.batchId],
            );
          }
        },
        ...over,
      });
    },
    close: () => app.close(),
  };
}

/** CSV text for the sample importer from plain rows. */
export const peopleCsv = (...rows: string[]): string =>
  ['Name,Amount,Joined,Kind', ...rows].join('\n') + '\n';

/** Clears everything the tests create between cases (the audit log is append-only and is kept). */
export async function resetImporter(kit: ImporterKit): Promise<void> {
  for (const table of ['imp_errors', 'imp_batches', 'tst_people', 'sys_outbox']) {
    await kit.db.query(`delete from ${table}`);
  }
}
