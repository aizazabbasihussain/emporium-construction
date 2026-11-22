import { createTestDb, type SqlDb } from '@emporium/db';
import type { ExportRow } from '@emporium/domain/accounting';
import {
  accountingPermissionGrants,
  accountingPermissions,
  identityPermissions,
  platformPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import type { ExportSources, Loaded, TaggableDoc } from './service/context.js';
import { createExportsService, type ExportsService } from './service/exports.service.js';
import { createTaggingService, type TaggingService } from './service/tagging.service.js';
import type { Actor, ExportCode } from './types.js';

const SECRET = new TextEncoder().encode('accounting-test-secret-accounting-test-secret');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-bbbb-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const ACCOUNTANT = uid(3);
export const SUPERVISOR = uid(4);
export const NOBODY = uid(5);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

/** The clock of the kit: Sunday 25 October 2026, 15:00 in Karachi. */
export const TODAY = '2026-10-25';

export interface Attached {
  id: string;
  entityType: string;
  entityId: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface AccountingKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  exports: ExportsService;
  tagging: TaggingService;
  app: FastifyInstance;
  now: { current: Date };
  /** What the fake owning modules report: set `loaded[code]` and `docs` before a run. */
  loaded: Partial<Record<ExportCode, Loaded>>;
  docs: TaggableDoc[];
  /** The files the exports attached, and the access checks the module registered. */
  attached: Attached[];
  accessChecks: Map<string, unknown>;
  actorFor(userId: string): Actor;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;

export async function createAccountingKit(): Promise<AccountingKit> {
  const db = await createTestDb();
  const now = { current: new Date('2026-10-25T10:00:00Z') };
  const clock = { now: () => new Date(now.current) };
  const newId = () => `018f7c7c-bbbb-7000-8000-${String(++counter).padStart(12, '0')}`;
  const platform = createPlatform({ clock, newId });
  const identity = createIdentity({
    platform,
    verifier: createJwtVerifier({ key: SECRET, audience: AUDIENCE, now: clock.now }),
    newId,
  });
  identity.registerPermissions('platform', Object.values(platformPermissions));
  identity.registerPermissions('identity', Object.values(identityPermissions));
  identity.registerPermissions('accounting', Object.values(accountingPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);

  const loaded: AccountingKit['loaded'] = {};
  const docs: TaggableDoc[] = [];
  const attached: Attached[] = [];
  const accessChecks = new Map<string, unknown>();
  const sources: ExportSources = {
    load: async (_db, code) => loaded[code] ?? { rows: [], control: {} },
    taggable: async (_db, range) =>
      docs.filter(
        (doc) =>
          (range.from === undefined || doc.date >= range.from) &&
          (range.to === undefined || doc.date <= range.to),
      ),
  };
  const files = {
    attach: async (upload: Omit<Attached, 'id'>) => {
      const id = newId();
      attached.push({ id, ...upload });
      return { attachment: { id }, created: true } as never;
    },
    registerFileAccess: (entityType: string, check: unknown) => {
      accessChecks.set(entityType, check);
    },
  };
  const deps = { platform, clock, newId, sources, files };
  const exports = createExportsService(deps);
  const tagging = createTaggingService(deps);

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
    accounting: { db, exports, tagging, platform },
  });
  await app.ready();

  const rolesOf = (userId: string) => USERS.filter(([id]) => id === userId).map(([, , r]) => r);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;

  return {
    db,
    platform,
    identity,
    exports,
    tagging,
    app,
    now,
    loaded,
    docs,
    attached,
    accessChecks,
    actorFor(userId) {
      const roles = rolesOf(userId);
      return {
        userId,
        roles,
        scopes: [],
        permissions: new Set(
          Object.entries(accountingPermissionGrants)
            .filter(([, granted]) => granted.some((role) => roles.includes(role)))
            .map(([permission]) => permission),
        ),
        requestId: null,
        name: emailOf(userId),
      };
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
    close: () => app.close(),
  };
}

/** A receipts-register row that came from a document line. */
export const receiptRow = (
  number: string,
  amount: string,
  over: Record<string, string | null> = {},
): ExportRow => ({
  values: {
    fiscal_year: 'FY2026-27',
    month: '2026-10',
    date: '2026-10-05',
    number,
    party: 'Synthetic Client',
    method: 'bank_transfer',
    amount,
    withheld: '0.00',
    ...over,
  },
  tag: { docType: 'receipt', docId: `doc-${number}`, lineRef: '' },
});

/** A taggable document. */
export const taggable = (docId: string, over: Partial<TaggableDoc> = {}): TaggableDoc => ({
  docType: 'invoice',
  docId,
  lineRef: '',
  date: '2026-10-05',
  attrs: {},
  number: `INV-${docId}`,
  party: 'Synthetic Client',
  amount: '1000.00',
  description: '',
  ...over,
});
