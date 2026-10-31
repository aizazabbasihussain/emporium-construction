import { en } from '@emporium/shared';
import * as shared from '@emporium/shared';
import { expect, test, type Page } from '@playwright/test';
import { navItems } from '../src/shell/nav';

// Gate A smoke tests (P1-21 T-8): for each pilot role the five screens they use most open for
// them, and a screen they must not see is refused. The browser talks to a mocked Supabase Auth and
// a mocked API, so no backend runs; permissions are the grants the modules seed for each role.
const SUPABASE = 'http://localhost:54321';

const session = {
  access_token: 'e2e-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'e2e-refresh-token',
  user: {
    id: 'e2e-subject',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'person@example.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-24T00:00:00Z',
  },
};

const grants = Object.entries(shared)
  .filter(([name]) => name.endsWith('PermissionGrants'))
  .flatMap(([, value]) => Object.entries(value as Record<string, readonly string[]>));

const permissionsOf = (role: string) =>
  grants.filter(([, roles]) => roles.includes(role)).map(([permission]) => permission);

const labelOf = (path: string): string => {
  const item = navItems.find((candidate) => candidate.path === path);
  if (item === undefined) throw new Error(`No menu item for ${path}`);
  const key = item.label.replace(/^nav\./, '') as keyof typeof en.nav;
  return en.nav[key];
};

interface RoleCase {
  role: string;
  screens: string[];
  /** A screen this role does not hold the permission for. */
  forbidden: string;
}

const cases: RoleCase[] = [
  {
    role: 'management',
    screens: ['/approvals', '/projects', '/quotations', '/reports', '/wages/periods'],
    forbidden: '/admin/settings',
  },
  {
    role: 'project_manager',
    screens: [
      '/projects',
      '/crm/leads',
      '/dpr/reports',
      '/attendance/sheets',
      '/procurement/requisitions',
    ],
    forbidden: '/wages/periods',
  },
  {
    role: 'supervisor',
    screens: [
      '/dpr/reports',
      '/attendance/sheets',
      '/workforce/my-teams',
      '/expenses/claims',
      '/projects',
    ],
    forbidden: '/wages/periods',
  },
  {
    role: 'storekeeper',
    screens: [
      '/inventory/stock',
      '/inventory/issue',
      '/inventory/ledger',
      '/inventory/counts',
      '/inventory/transfers',
    ],
    forbidden: '/wages/periods',
  },
  {
    role: 'accountant',
    screens: [
      '/wages/periods',
      '/expenses/queue',
      '/valuation/report',
      '/reports',
      '/attendance/sheets',
    ],
    forbidden: '/procurement/purchase-orders',
  },
  {
    role: 'procurement',
    screens: [
      '/procurement/requisitions',
      '/procurement/purchase-orders',
      '/inventory/stock',
      '/master/parties',
      '/reports',
    ],
    forbidden: '/wages/periods',
  },
];

async function mockBackend(page: Page, role: string) {
  const profile = {
    id: '018f9000-0000-7000-8000-000000000001',
    email: 'person@example.test',
    fullName: `Pilot ${role}`,
    locale: 'en',
    version: 1,
    roles: [role],
    permissions: permissionsOf(role),
    scopes: [],
  };
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  // Data requests answer with an empty page; navigation and assets go to the dev server.
  await page.route(
    (url) => url.origin !== SUPABASE,
    (route) => {
      const type = route.request().resourceType();
      const { pathname } = new URL(route.request().url());
      if ((type !== 'fetch' && type !== 'xhr') || /^\/(@|src\/|node_modules\/)/.test(pathname)) {
        return route.fallback();
      }
      if (pathname === '/me') return route.fulfill({ json: profile });
      return route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } });
    },
  );
}

for (const { role, screens, forbidden } of cases) {
  test(`${role} opens the five main screens and is refused the others`, async ({ page }) => {
    await mockBackend(page, role);
    await page.goto('/');
    await page.getByLabel('Email').fill('person@example.test');
    await page.getByLabel('Password').fill('correct');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();

    for (const path of screens) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(page.getByText('You do not have permission to open this page.')).toHaveCount(0);
    }

    await page.goto(forbidden);
    await expect(page.getByText('You do not have permission to open this page.')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: labelOf(forbidden), exact: true })).toHaveCount(
      0,
    );
  });
}
