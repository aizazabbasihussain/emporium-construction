import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTablesWithoutRls } from '@emporium/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, PILOT_USERS, type Harness, type PilotUserKey } from './harness.js';
import { expandRoute, listRoutes, urlFor, type RouteRef } from './routes.js';

const MATRIX_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'permission-matrix.expected.json',
);

/** Routes that are open on purpose: the health probe and the signed download link (its signature is the credential). */
const PUBLIC_ROUTES = new Set(['GET /health', 'GET /files/blob']);

const ROLE_USERS: PilotUserKey[] = [
  'admin',
  'owner',
  'pm',
  'estimator',
  'procurement',
  'storekeeper',
  'accountant',
  'supervisor',
  'coordinator',
  'nobody',
];

const label = (route: RouteRef) => `${route.method} ${route.pattern}`;

describe('Gate A security checks (P1-21 BR-4)', () => {
  let h: Harness;
  let routes: RouteRef[];
  beforeAll(async () => {
    h = await createHarness();
    routes = listRoutes(h.app).flatMap(expandRoute);
  });
  afterAll(() => h.close());

  it('finds the whole route table', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.map(label)).toContain('GET /health');
  });

  // T-3: RLS completeness
  it('has Row Level Security enabled on every table', async () => {
    expect(await findTablesWithoutRls(h.db)).toEqual([]);
  });

  it('denies a row to every non-owner role: no policy lets a role read a table', async () => {
    const policies = await h.db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public'`,
    );
    expect(policies).toEqual([]);
  });

  // T-3: unauthenticated route sweep
  it('requires authentication on every route except the public ones', async () => {
    const open: string[] = [];
    for (const route of routes) {
      const res = await h.call(null, route.method as 'GET', urlFor(route), {});
      if (res.status !== 401 && !PUBLIC_ROUTES.has(label(route))) open.push(label(route));
    }
    expect(open).toEqual([]);
  });

  it('rejects a forged token on every route', async () => {
    const bad = { authorization: 'Bearer not-a-token' };
    const open: string[] = [];
    for (const route of routes) {
      const res = await h.app.inject({
        method: route.method as 'GET',
        url: urlFor(route),
        headers: bad,
      });
      if (res.statusCode !== 401 && !PUBLIC_ROUTES.has(label(route))) open.push(label(route));
    }
    expect(open).toEqual([]);
  });

  // T-2: the permission matrix
  it('matches the expected permission matrix with zero unexpected grants', async () => {
    const actual: Record<string, string[]> = {};
    for (const route of routes) {
      const allowed: string[] = [];
      for (const user of ROLE_USERS) {
        const res = await h.call(user, route.method as 'GET', urlFor(route), {});
        if (res.status !== 403 && res.status !== 401) allowed.push(user);
      }
      actual[label(route)] = allowed;
    }
    // Regenerate only on purpose: `UPDATE_PERMISSION_MATRIX=1 pnpm test`, then review the diff.
    if (process.env.UPDATE_PERMISSION_MATRIX === '1') {
      writeFileSync(MATRIX_FILE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(MATRIX_FILE, 'utf8')) as Record<string, string[]>;
    const unexpected = Object.entries(actual).flatMap(([route, users]) =>
      users
        .filter((user) => !(expected[route] ?? []).includes(user))
        .map((user) => `${user} -> ${route}`),
    );
    const missing = Object.keys(expected).filter((route) => !(route in actual));
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
  }, 300_000);

  it('grants a user with no role nothing beyond their own profile and notifications', async () => {
    const expected = JSON.parse(readFileSync(MATRIX_FILE, 'utf8')) as Record<string, string[]>;
    const granted = Object.entries(expected)
      .filter(([, users]) => users.includes('nobody'))
      .map(([route]) => route);
    const own = (route: string) =>
      /^(GET|PATCH) \/me$/.test(route) ||
      route.includes('/notifications') ||
      route.startsWith('GET /health') ||
      route.startsWith('GET /files/blob') ||
      // Saved report filters belong to their user and expose no report data.
      route.includes('/reports/saved-filters') ||
      route.startsWith('GET /crm/reference') ||
      route.startsWith('GET /approvals/inbox');
    expect(granted.filter((route) => !own(route))).toEqual([]);
  });

  it('keeps the matrix aligned with the pilot roles', () => {
    const roles = new Set(PILOT_USERS.map((user) => user.role));
    expect(roles.size).toBeGreaterThanOrEqual(8);
  });
});
