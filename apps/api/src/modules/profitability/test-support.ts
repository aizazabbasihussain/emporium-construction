import { createTestDb, type SqlDb } from '@emporium/db';
import { NotFoundError } from '@emporium/domain';
import { Money } from '@emporium/domain/kernel';
import {
  identityPermissions,
  platformPermissions,
  profitabilityPermissionGrants,
  profitabilityPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createIdentity, createJwtVerifier, type Identity } from '../identity/index.js';
import { createPlatform, type Platform } from '../platform/index.js';
import { createProfitability, type Profitability } from './index.js';
import type { Actor } from './types.js';

const SECRET = new TextEncoder().encode('profitability-test-secret-profitability-test');
const AUDIENCE = 'authenticated';

export const uid = (n: number) => `018f7a7a-aaaa-7000-8000-${String(n).padStart(12, '0')}`;

export const ADMIN = uid(1);
export const MANAGEMENT = uid(2);
export const PM = uid(3);
export const PM2 = uid(4);
export const ACCOUNTANT = uid(5);
export const SUPERVISOR = uid(6);
export const NOBODY = uid(7);

const USERS: [string, string, string][] = [
  [ADMIN, 'admin@example.test', 'admin'],
  [MANAGEMENT, 'management@example.test', 'management'],
  [PM, 'pm@example.test', 'project_manager'],
  [PM2, 'pm2@example.test', 'project_manager'],
  [ACCOUNTANT, 'accountant@example.test', 'accountant'],
  [SUPERVISOR, 'supervisor@example.test', 'supervisor'],
  [NOBODY, 'nobody@example.test', 'nopower'],
];

/** The clock of the kit: Sunday 25 October 2026, 15:00 in Karachi. */
export const TODAY = '2026-10-25';

/** Everything the fake owning modules know about one project; every figure carries its date. */
export interface FakeProject {
  id: string;
  code: string;
  name: string;
  status: string;
  projectManagerId: string | null;
  originalContractValue: string;
  budget: string;
  variations: { date: string; amount: string }[];
  costs: { date: string; status: 'committed' | 'approved' | 'posted'; amount: string }[];
  invoices: { date: string; due: string; base: string; tax: string; gross: string }[];
  credits: { date: string; base: string; tax: string; gross: string }[];
  receipts: { date: string; gross: string; withheld: string; base: string }[];
  paid: {
    vendors: { date: string; amount: string }[];
    wages: { date: string; amount: string }[];
    expenses: { date: string; amount: string }[];
  };
}

export interface Notified {
  kind: 'user' | 'role';
  to: string[] | string;
  template: string;
  data: Record<string, unknown>;
}

export interface ProfitabilityKit {
  db: SqlDb;
  platform: Platform;
  identity: Identity;
  profitability: Profitability;
  app: FastifyInstance;
  now: { current: Date };
  projects: Map<string, FakeProject>;
  notified: Notified[];
  /** Adds a project to the fake owning modules. */
  project(over?: Partial<FakeProject>): FakeProject;
  /** A caller holding the permissions its role gets from the migration. */
  actorFor(userId: string): Actor;
  auth(userId: string): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

let counter = 0;

const sum = (items: readonly { amount: string }[]): string =>
  items.reduce((total, item) => total.add(Money.of(item.amount)), Money.zero()).toString();
const upTo = <T extends { date: string }>(items: readonly T[], asOf: string): T[] =>
  items.filter((item) => item.date <= asOf);
const total = (items: readonly string[]): string =>
  items.reduce((all, value) => all.add(Money.of(value)), Money.zero()).toString();

export async function createProfitabilityKit(): Promise<ProfitabilityKit> {
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
  identity.registerPermissions('profitability', Object.values(profitabilityPermissions));
  await identity.roles.register('nopower', 'No power', 'Holds no permissions', db);

  const projects = new Map<string, FakeProject>();
  const notified: Notified[] = [];
  const get = (id: string): FakeProject => {
    const found = projects.get(id);
    if (found === undefined) throw new NotFoundError('project_not_found', 'Not found');
    return found;
  };

  /** The fake owning modules answer from the dated facts of a project, as the real ones do. */
  const profitability = createProfitability({
    platform,
    clock,
    newId,
    projects: {
      getProject: async (_db, id) => get(id) as never,
      listProjectsForUser: async () => [...projects.values()] as never,
      getCostSummary: async (_db, object, asOf) => {
        const project = get(object.id as string);
        const dated = asOf === undefined ? project.costs : upTo(project.costs, asOf);
        const by = (status: string) => sum(dated.filter((c) => c.status === status));
        return {
          totals: { committed: by('committed'), approved: by('approved'), posted: by('posted') },
          budget: Money.of(project.budget).toString(),
        } as never;
      },
    },
    variations: {
      getCurrentContractValue: async (_db, id, asOf) => {
        const project = get(id);
        const dated = asOf === undefined ? project.variations : upTo(project.variations, asOf);
        return total([project.originalContractValue, sum(dated)]);
      },
    },
    billing: {
      getProjectBilling: async (_db, id, asOf) => {
        const project = get(id);
        const invoices = upTo(project.invoices, asOf);
        const credits = upTo(project.credits, asOf);
        const net = (key: 'base' | 'tax' | 'gross') =>
          Money.of(sum(invoices.map((i) => ({ amount: i[key] }))))
            .sub(Money.of(sum(credits.map((c) => ({ amount: c[key] })))))
            .toString();
        return { base: net('base'), tax: net('tax'), gross: net('gross') };
      },
    },
    receivables: {
      getProjectCollected: async (_db, id, asOf) => {
        const receipts = upTo(get(id).receipts, asOf);
        const by = (key: 'gross' | 'withheld' | 'base') =>
          sum(receipts.map((r) => ({ amount: r[key] })));
        return { gross: by('gross'), withheld: by('withheld'), base: by('base') };
      },
      getProjectAging: async (_db, id, asOf) => {
        const project = get(id);
        let collected = Money.of(
          sum(upTo(project.receipts, asOf).map((r) => ({ amount: r.gross }))),
        );
        const open: { due: string; left: Money }[] = [];
        for (const invoice of [...upTo(project.invoices, asOf)].sort((a, b) =>
          a.due.localeCompare(b.due),
        )) {
          const gross = Money.of(invoice.gross);
          const taken = collected.compare(gross) > 0 ? gross : collected;
          collected = collected.sub(taken);
          if (!gross.sub(taken).isZero()) open.push({ due: invoice.due, left: gross.sub(taken) });
        }
        return {
          asOf,
          outstanding: total(open.map((o) => o.left.toString())),
          openInvoices: open.length,
          oldestDueDate: open[0]?.due ?? null,
        };
      },
    },
    payables: {
      getPaidForProject: async (_db, id, asOf) => sum(upTo(get(id).paid.vendors, asOf)),
    },
    payroll: {
      getPaidWagesForProject: async (_db, id, asOf) => sum(upTo(get(id).paid.wages, asOf)),
    },
    expenses: {
      getReimbursedForProject: async (_db, id, asOf) => sum(upTo(get(id).paid.expenses, asOf)),
    },
    notifications: {
      registerTemplate: () => undefined,
      notify: async (userIds, template, data) => {
        notified.push({ kind: 'user', to: [...userIds], template, data });
        return [] as never;
      },
      notifyRole: async (role, template, data) => {
        notified.push({ kind: 'role', to: role, template, data });
        return [] as never;
      },
    },
  });

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
    profitability: { db, profitability: profitability.service, platform },
  });
  await app.ready();

  const rolesOf = (userId: string) => USERS.filter(([id]) => id === userId).map(([, , r]) => r);
  const emailOf = (userId: string) => USERS.find(([id]) => id === userId)?.[1] as string;

  const kit: ProfitabilityKit = {
    db,
    platform,
    identity,
    profitability,
    app,
    now,
    projects,
    notified,

    project(over = {}) {
      counter += 1;
      const id = uid(1000 + counter);
      const created: FakeProject = {
        id,
        code: `P-${String(counter).padStart(4, '0')}`,
        name: `Synthetic project ${counter}`,
        status: 'active',
        projectManagerId: PM,
        originalContractValue: '0.00',
        budget: '0.00',
        variations: [],
        costs: [],
        invoices: [],
        credits: [],
        receipts: [],
        paid: { vendors: [], wages: [], expenses: [] },
        ...over,
      };
      projects.set(id, created);
      return created;
    },

    actorFor(userId) {
      const roles = rolesOf(userId);
      return {
        userId,
        roles,
        scopes: [],
        permissions: new Set(
          Object.entries(profitabilityPermissionGrants)
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
  return kit;
}

/**
 * The scripted project of spec T-1, every figure worked out by hand (see the worksheet in the test):
 * contract 1,000,000 + a variation of 100,000 approved on 2026-10-10.
 */
export function scriptedProject(kit: ProfitabilityKit, over: Partial<FakeProject> = {}) {
  return kit.project({
    originalContractValue: '1000000.00',
    budget: '900000.00',
    variations: [{ date: '2026-10-10', amount: '100000.00' }],
    invoices: [
      {
        date: '2026-10-01',
        due: '2026-10-31',
        base: '600000.00',
        tax: '108000.00',
        gross: '708000.00',
      },
      {
        date: '2026-10-12',
        due: '2026-11-11',
        base: '300000.00',
        tax: '54000.00',
        gross: '354000.00',
      },
    ],
    credits: [{ date: '2026-10-15', base: '100000.00', tax: '18000.00', gross: '118000.00' }],
    receipts: [
      { date: '2026-10-08', gross: '354000.00', withheld: '12000.00', base: '300000.00' },
      { date: '2026-10-20', gross: '236000.00', withheld: '8000.00', base: '200000.00' },
    ],
    costs: [
      { date: '2026-10-02', status: 'committed', amount: '100000.00' },
      { date: '2026-10-05', status: 'approved', amount: '120000.00' },
      { date: '2026-10-18', status: 'approved', amount: '80000.00' },
      { date: '2026-10-06', status: 'posted', amount: '300000.00' },
    ],
    paid: {
      vendors: [
        { date: '2026-10-09', amount: '150000.00' },
        { date: '2026-10-22', amount: '100000.00' },
      ],
      wages: [{ date: '2026-10-21', amount: '120000.00' }],
      expenses: [{ date: '2026-10-19', amount: '10000.00' }],
    },
    ...over,
  });
}
