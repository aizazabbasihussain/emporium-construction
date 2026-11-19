import { expect, test, type Page, type Route } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API that keeps the state of a till and a
// bank statement: a receipt is recorded and shows in the cash book with its running balance, then
// the bank statement is matched and completed at a zero difference.
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
    'cashbook.account.manage',
    'cashbook.txn.read',
    'cashbook.txn.create',
    'cashbook.txn.reverse',
    'cashbook.reconciliation.manage',
  ],
  scopes: [],
};

const till = {
  id: 'a1',
  code: 'TILL',
  name: 'Main till',
  kind: 'cash',
  bankName: null,
  accountNumberMasked: null,
  accountCodeTag: null,
  openingBalance: '1000.00',
  openingDate: '2026-01-01',
  allowOverdraft: false,
  active: true,
  version: 1,
  balance: '1000.00',
};

interface State {
  received: boolean;
  matched: boolean;
  completed: boolean;
}

const receipt = {
  id: 't1',
  number: 'CB-2026-00001',
  accountId: 'a1',
  txnDate: '2026-11-18',
  direction: 'in',
  amount: '500.00',
  txnType: 'receipt',
  method: 'cash',
  reference: 'CHQ-1',
  description: 'Stage 1',
  accountTag: null,
  reconciledIn: null,
  reversesId: null,
  reversed: false,
  transferPairId: null,
  runningBalance: '1500.00',
};

const workspace = (state: State) => ({
  id: 'r1',
  accountId: 'a1',
  statementFrom: '2026-11-01',
  statementTo: '2026-11-18',
  statementClosingBalance: '1500.00',
  bookBalanceAtEnd: state.completed ? '1500.00' : null,
  difference: state.completed ? '0.00' : null,
  status: state.completed ? 'completed' : 'draft',
  version: 1,
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      lineDate: '2026-11-18',
      description: 'Deposit',
      debit: '0.00',
      credit: '500.00',
      matchedTransactionId: state.matched ? 't1' : null,
    },
  ],
  candidates: state.matched ? [] : [receipt],
  suggestions: state.matched ? [] : [{ lineId: 'l1', transactionId: 't1', dayDifference: 0 }],
  figures: {
    bookBalance: '1500.00',
    bookUnreconciled: state.matched ? '0.00' : '500.00',
    statementUnreconciled: state.matched ? '0.00' : '500.00',
    expectedClosing: '1500.00',
    difference: '0.00',
  },
});

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

async function mockBackend(page: Page) {
  const state: State = { received: false, matched: false, completed: false };
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/me', (route) => route.fulfill({ json: profile }));
  await page.route(
    (url) => url.pathname.startsWith('/cashbook'),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path === '/cashbook/accounts') {
        return json(route, [{ ...till, balance: state.received ? '1500.00' : '1000.00' }]);
      }
      if (path === '/cashbook/receipts' && method === 'POST') {
        expect(request.postDataJSON()).toMatchObject({
          accountId: 'a1',
          amount: '500',
          method: 'cash',
          reference: 'CHQ-1',
        });
        state.received = true;
        return json(route, receipt, 201);
      }
      if (path === '/cashbook/transactions') {
        return json(route, {
          items: state.received ? [receipt] : [],
          total: state.received ? 1 : 0,
          limit: 100,
          offset: 0,
        });
      }
      if (path === '/cashbook/reconciliations' && method === 'GET') {
        return json(route, [workspace(state)]);
      }
      if (path === '/cashbook/reconciliations/r1/match') {
        state.matched = true;
        return json(route, workspace(state));
      }
      if (path === '/cashbook/reconciliations/r1/complete') {
        state.completed = true;
        return json(route, workspace(state));
      }
      if (path === '/cashbook/reconciliations/r1') return json(route, workspace(state));
      return json(route, []);
    },
  );
  return state;
}

test('cash book: a receipt shows with its balance, then the bank statement is reconciled', async ({
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

  // A receipt into the till.
  await page.getByRole('menuitem', { name: 'Cash book' }).click();
  await page.getByRole('link', { name: 'New receipt' }).click();
  const account = page.getByRole('combobox', { name: 'Account' });
  await account.click();
  await expect(
    page.locator('.ant-select-item-option', { hasText: 'TILL Main till' }),
  ).toBeVisible();
  // The first option is the active one; the keyboard avoids clicking through the opening animation.
  await account.press('Enter');
  await expect(
    page.locator('.ant-select-content-has-value[title^="TILL Main till"]'),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Amount' }).fill('500');
  await page.getByRole('textbox', { name: 'Reference' }).fill('CHQ-1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => state.received).toBe(true);

  // The cash book shows the entry and the balance after it.
  await expect(page.getByText('CB-2026-00001')).toBeVisible();
  await expect(page.getByText('1,500.00').first()).toBeVisible();

  // The bank statement: accept the suggested match, then complete at a zero difference.
  await page.getByRole('menuitem', { name: 'Bank reconciliation' }).click();
  await page.getByRole('link', { name: /01\/11\/2026/ }).click();
  await page.getByRole('button', { name: 'Accept 1 suggested matches' }).click();
  await expect.poll(() => state.matched).toBe(true);
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect.poll(() => state.completed).toBe(true);
  await expect(page.getByText('Completed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete' })).toHaveCount(0);
});
