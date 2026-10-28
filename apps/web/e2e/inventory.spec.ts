import { expect, test, type Page, type Route } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API that keeps the state of one store:
// 60 bags arrive through a goods receipt, the storekeeper issues 10 bags to a project and the
// ledger and the project cost show the issue. No backend runs.
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
  id: '018f2222-0000-7000-8000-000000000005',
  email: 'storekeeper@example.test',
  fullName: 'Store Keeper',
  locale: 'en',
  version: 1,
  roles: ['storekeeper'],
  permissions: [
    'inventory.stock.read',
    'inventory.stock.issue',
    'inventory.stock.return',
    'inventory.stock.transfer',
    'inventory.stock.count',
    'inventory.store.manage',
  ],
  scopes: [],
};

const page_ = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });

interface State {
  quantity: number;
  issued: { quantity: string; value: string } | null;
}

function api(state: State) {
  const stock = () => ({
    storeId: 's1',
    itemId: 'i1',
    ownership: 'company',
    ownerPartyId: null,
    quantity: `${state.quantity.toFixed(4)}`,
  });
  const ledger = () => [
    {
      id: 'l1',
      seq: 1,
      storeId: 's1',
      itemId: 'i1',
      ownership: 'company',
      movementType: 'receipt',
      quantity: '60.0000',
      unitCost: '60.0000',
      value: '3600.00',
      sourceDocType: 'grn',
      businessDate: '2026-10-25',
    },
    ...(state.issued === null
      ? []
      : [
          {
            id: 'l2',
            seq: 2,
            storeId: 's1',
            itemId: 'i1',
            ownership: 'company',
            movementType: 'issue',
            quantity: '-10.0000',
            unitCost: '60.0000',
            value: state.issued.value,
            sourceDocType: 'issue',
            businessDate: '2026-10-25',
          },
        ]),
  ];
  return async (route: Route) => {
    const request = route.request();
    if (request.resourceType() === 'document') return route.fallback();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname === '/master/items') {
      return json(
        page_([
          { id: 'i1', code: 'CEM', name: 'Cement', stockable: true, defaultCostCodeId: 'cc1' },
        ]),
      );
    }
    if (url.pathname === '/master/cost-codes') {
      return json(page_([{ id: 'cc1', code: '100', name: 'Materials' }]));
    }
    if (url.pathname === '/master/parties') return json(page_([]));
    if (url.pathname === '/projects') {
      return json(page_([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall' }]));
    }
    if (url.pathname === '/inventory/stores') {
      return json(page_([{ id: 's1', code: 'WH-1', name: 'Main warehouse', active: true }]));
    }
    if (url.pathname === '/inventory/stock') return json(page_([stock()]));
    if (url.pathname === '/inventory/ledger') return json(page_(ledger()));
    if (url.pathname === '/inventory/issues' && request.method() === 'POST') {
      const body = request.postDataJSON() as { quantity: string };
      state.quantity -= Number(body.quantity);
      state.issued = { quantity: body.quantity, value: '600.00' };
      return json({ id: 'is1', quantity: '10.0000', value: '600.00', costEntryId: 'e1' }, 201);
    }
    return json(page_([]));
  };
}

/** Types into a searchable select and clicks the match. */
async function choose(page: Page, label: string, text: string) {
  const select = page.getByRole('combobox', { name: label });
  await select.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/dbg-' + label + '.png' });
  await select.fill(text);
  await expect(page.getByTitle(text)).toBeVisible();
  await page.getByTitle(text).click();
  await expect(page.locator('.ant-select-selection-item', { hasText: text })).toBeVisible();
}

async function mockBackend(page: Page) {
  const state: State = { quantity: 60, issued: null };
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/me', (route) => route.fulfill({ json: profile }));
  await page.route(
    (url) =>
      url.pathname.startsWith('/inventory') ||
      url.pathname.startsWith('/master') ||
      url.pathname === '/projects',
    api(state),
  );
  return state;
}

test('goods receipt to store, issue to a project, project cost', async ({ page }) => {
  const state = await mockBackend(page);
  page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 300)));
  page.on('request', (r) => r.url().includes('/inventory') && console.log('REQ', r.url()));
  await page.goto('/');
  await page.getByLabel('Email').fill('storekeeper@example.test');
  await page.getByLabel('Password').fill('correct');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();

  // The goods receipt has put 60 bags of cement into the main warehouse.
  await page.getByRole('menuitem', { name: 'Stock on hand' }).click();
  await expect(page.getByRole('heading', { name: 'Stock on hand' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '60.0000' })).toBeVisible();

  // The storekeeper issues 10 bags to the project; the item's default cost code is used.
  await page.getByRole('menuitem', { name: 'Issue material' }).click();
  await page.waitForLoadState('networkidle');
  await choose(page, 'Store', 'WH-1 Main warehouse');
  await choose(page, 'Item', 'CEM Cement');
  await page.getByLabel('Quantity').fill('10');
  await choose(page, 'Project', 'PRJ-0001 Boundary wall');
  await page.getByRole('button', { name: 'Issue' }).click();
  await expect(page.getByText('Issued 10.0000; cost 600.00 posted to the project.')).toBeVisible();
  expect(state.issued).toEqual({ quantity: '10', value: '600.00' });

  // The stock went down and the ledger shows the valued issue.
  await page.getByRole('menuitem', { name: 'Stock on hand' }).click();
  await expect(page.getByRole('cell', { name: '50.0000' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Stock ledger' }).click();
  await expect(page.getByRole('cell', { name: '600.00' })).toBeVisible();
});
