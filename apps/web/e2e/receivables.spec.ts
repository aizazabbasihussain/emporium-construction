import { expect, test, type Page, type Route } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API that keeps the state of one invoice
// and one post-dated cheque: the cheque is recorded against the invoice, deposited and cleared.
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
    email: 'accountant@example.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-11-18T00:00:00Z',
  },
};

const profile = {
  id: '018f2222-0000-7000-8000-000000000005',
  email: 'accountant@example.test',
  fullName: 'Accountant',
  locale: 'en',
  version: 1,
  roles: ['accountant'],
  permissions: [
    'receivables.receipt.create',
    'receivables.receipt.cancel',
    'receivables.pdc.manage',
    'receivables.ledger.read',
    'receivables.adjustment.create',
    'cashbook.txn.read',
  ],
  scopes: [],
};

const party = { id: 'p1', code: 'C-1', name: 'Synthetic Client', roles: ['client'], version: 1 };
const bank = {
  id: 'a2',
  code: 'BANK',
  name: 'Synthetic Bank',
  kind: 'bank',
  active: true,
  version: 1,
  balance: '0.00',
};
const invoice = {
  invoiceId: 'i1',
  number: 'INV-2026-0001',
  projectId: 'pr1',
  partyId: 'p1',
  invoiceDate: '2026-11-01',
  dueDate: '2026-11-15',
  gross: '1000.00',
  outstanding: '1000.00',
  pending: '0.00',
  allocatable: '1000.00',
  withholdingExpected: '0.00',
  withholdingAllocated: '0.00',
};

interface State {
  status: 'none' | 'received' | 'deposited' | 'cleared';
  received: Record<string, unknown> | undefined;
}

const cheque = (state: State) => ({
  id: 'c1',
  receiptId: 'r1',
  partyId: 'p1',
  chequeNumber: 'CH-7',
  bankName: 'HBL',
  drawer: null,
  chequeDate: '2026-11-18',
  amount: '1000.00',
  status: state.status,
  version: ['none', 'received', 'deposited', 'cleared'].indexOf(state.status),
});

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

async function mockBackend(page: Page) {
  const state: State = { status: 'none', received: undefined };
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/me', (route) => route.fulfill({ json: profile }));
  await page.route(
    (url) => url.pathname.startsWith('/master/parties'),
    (route) => json(route, { items: [party], total: 1, limit: 100, offset: 0 }),
  );
  await page.route(
    (url) => url.pathname.startsWith('/cashbook'),
    (route) => json(route, [bank]),
  );
  await page.route(
    (url) => url.pathname.startsWith('/receivables'),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path === '/receivables/customers/p1/open-invoices') return json(route, [invoice]);
      if (path === '/receivables/receipts' && method === 'POST') {
        state.received = request.postDataJSON() as Record<string, unknown>;
        state.status = 'received';
        return json(
          route,
          {
            id: 'r1',
            number: 'RV-2026-0001',
            partyId: 'p1',
            receiptDate: '2026-11-18',
            method: 'pdc',
            amount: '1000.00',
            status: 'pending_clearing',
            withheldAmount: '0.00',
            unallocated: '0.00',
            allocations: [],
            withholdingFlags: [],
            version: 1,
          },
          201,
        );
      }
      if (path === '/receivables/pdcs' && method === 'GET') {
        const items = state.status === 'none' ? [] : [cheque(state)];
        return json(route, {
          items,
          upcoming: state.status === 'received' ? items : [],
          totalInHand: state.status === 'cleared' ? '0.00' : '1000.00',
          byStatus: {},
        });
      }
      if (path === '/receivables/pdcs/c1/deposit') {
        expect(request.postDataJSON()).toMatchObject({ accountId: 'a2', version: 1 });
        state.status = 'deposited';
        return json(route, cheque(state));
      }
      if (path === '/receivables/pdcs/c1/clear') {
        state.status = 'cleared';
        return json(route, cheque(state));
      }
      return json(route, []);
    },
  );
  return state;
}

test('receivables: a post-dated cheque pays an invoice, is deposited and clears', async ({
  page,
}) => {
  const state = await mockBackend(page);
  await page.goto('/');
  await page.getByLabel('Email').fill('accountant@example.test');
  await page.getByLabel('Password').fill('correct');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();

  // The receipt: a post-dated cheque allocated to the open invoice.
  await page.getByRole('menuitem', { name: 'Client receipt' }).click();
  const customer = page.getByRole('combobox', { name: 'Customer' });
  await customer.click();
  await expect(
    page.locator('.ant-select-item-option', { hasText: 'Synthetic Client' }),
  ).toBeVisible();
  await customer.press('Enter');
  await expect(page.getByText('INV-2026-0001')).toBeVisible();
  const method = page.getByRole('combobox', { name: 'Method' });
  await method.click();
  await page.locator('.ant-select-item-option', { hasText: 'Post-dated cheque' }).click();
  await page.getByRole('textbox', { name: 'Amount' }).fill('1000');
  await page.getByRole('textbox', { name: 'Cheque number' }).fill('CH-7');
  await page.getByRole('textbox', { name: 'Bank' }).fill('HBL');
  await page.getByRole('textbox', { name: 'Allocate INV-2026-0001' }).fill('1000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => state.status).toBe('received');
  expect(state.received).toMatchObject({
    partyId: 'p1',
    method: 'pdc',
    amount: '1000',
    cheque: { chequeNumber: 'CH-7', bankName: 'HBL' },
    allocations: [{ kind: 'invoice', invoiceId: 'i1', amount: '1000' }],
  });
  await expect(page.getByText('Receipt RV-2026-0001 recorded.')).toBeVisible();

  // The register: deposit into the bank, then clear.
  await page.getByRole('menuitem', { name: 'Cheque register' }).click();
  await expect(page.getByText('CH-7').first()).toBeVisible();
  await page.getByRole('button', { name: 'Deposit' }).click();
  const account = page.getByRole('combobox', { name: 'Deposit into' });
  await account.click();
  await expect(
    page.locator('.ant-select-item-option', { hasText: 'BANK Synthetic Bank' }),
  ).toBeVisible();
  await account.press('Enter');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => state.status).toBe('deposited');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect.poll(() => state.status).toBe('cleared');
  await expect(page.getByRole('cell', { name: 'Cleared' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear' })).toHaveCount(0);
});
