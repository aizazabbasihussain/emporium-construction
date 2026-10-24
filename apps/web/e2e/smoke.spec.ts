import { expect, test, type Page } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API, so the flow runs with no backend.
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
    email: 'storekeeper@example.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-24T00:00:00Z',
  },
};

const profile = {
  id: '018f2222-0000-7000-8000-000000000004',
  email: 'storekeeper@example.test',
  fullName: 'Store Keeper',
  locale: 'en',
  version: 1,
  roles: ['accountant'],
  permissions: ['platform.audit.read'],
  scopes: [],
};

async function mockBackend(page: Page, options: { me?: object; status?: number } = {}) {
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => {
    const body = route.request().postDataJSON() as { password: string };
    return body.password === 'correct'
      ? route.fulfill({ json: session })
      : route.fulfill({
          status: 400,
          json: { error: 'invalid_grant', error_description: 'Invalid login credentials' },
        });
  });
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/me', (route) =>
    route.fulfill({ status: options.status ?? 200, json: options.me ?? profile }),
  );
  await page.route('**/admin/audit**', (route) => route.fulfill({ json: { items: [] } }));
}

async function signIn(page: Page, password = 'correct') {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill('storekeeper@example.test');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('signs in, sees only allowed pages, is blocked from the others, and signs out', async ({
  page,
}) => {
  await mockBackend(page);
  await signIn(page);

  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Home', 'Audit log']);

  await menu.getByRole('menuitem', { name: 'Audit log' }).click();
  await expect(page).toHaveURL(/\/admin\/audit$/);
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

  await page.goto('/admin/settings');
  await expect(page.getByText('You do not have permission to open this page.')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('switches to right-to-left layout', async ({ page }) => {
  await mockBackend(page);
  await page.route('**/me', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ json: { ...profile, locale: 'ur', version: 2 } })
      : route.fulfill({ json: profile }),
  );
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.getByText('اردو').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('rejects a wrong password and an account the system does not know', async ({ page }) => {
  await mockBackend(page);
  await signIn(page, 'wrong');
  await expect(page.getByText('Wrong email or password.')).toBeVisible();

  await page.unroute('**/me');
  await page.route('**/me', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'unknown_user', message: 'no account' } },
    }),
  );
  await page.getByLabel('Password').fill('correct');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/not set up for the system, or it is disabled/)).toBeVisible();
});
