import { expect, test, type Page, type Route } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API that keeps the state of one wage
// period: the accountant creates a run from the approved sheet, finalizes it and pays every line.
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
    'payroll.run.read',
    'payroll.run.create',
    'payroll.run.finalize',
    'payroll.payment.create',
    'payroll.payslip.read',
  ],
  scopes: [],
};

const bank = {
  id: 'a1',
  code: 'BANK',
  name: 'Synthetic Bank',
  kind: 'bank',
  active: true,
  version: 1,
  balance: '0.00',
};

type RunStatus = 'none' | 'draft' | 'finalized' | 'paid';

interface State {
  run: RunStatus;
  finalizeBody: Record<string, unknown> | undefined;
  payBody: Record<string, unknown> | undefined;
}

const run = (state: State) => ({
  id: 'r1',
  periodId: 'per1',
  year: 2026,
  month: 10,
  status: state.run === 'none' ? 'draft' : state.run,
  revision: 1,
  finalizedAt: null,
  totalNet: '3000.00',
  totalPaid: state.run === 'paid' ? '3000.00' : '0.00',
  totalUnpaid: state.run === 'paid' ? '0.00' : '3000.00',
  costDifferenceTreatment: 'spread_to_projects',
  version: 1,
  lineCount: 2,
  paidLineCount: state.run === 'paid' ? 2 : 0,
  cost: { grossPay: '3100.00', allocatedCost: '3000.00', difference: '100.00', adjustments: [] },
});

const lines = (state: State) =>
  ['1', '2'].map((n) => ({
    id: `l${n}`,
    runId: 'r1',
    workerId: `w${n}`,
    workerCode: `W-00${n}`,
    workerName: `Synthetic Worker ${n}`,
    netPay: '1500.00',
    paymentMethod: state.run === 'paid' ? 'cash' : null,
    paymentStatus: state.run === 'paid' ? 'paid' : 'unpaid',
    paidOn: state.run === 'paid' ? '2026-11-05' : null,
    paymentId: null,
    cashbookTxnId: null,
    payslipNumber: state.run === 'draft' || state.run === 'none' ? null : `PSL-2026-000${n}`,
  }));

const page = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

async function mockBackend(browser: Page) {
  const state: State = { run: 'none', finalizeBody: undefined, payBody: undefined };
  await browser.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await browser.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await browser.route('**/me', (route) => route.fulfill({ json: profile }));
  await browser.route(
    (url) => url.pathname.startsWith('/cashbook'),
    (route) => json(route, [bank]),
  );
  await browser.route(
    (url) => url.pathname.startsWith('/wages'),
    (route) => json(route, page([{ id: 'per1', year: 2026, month: 10, status: 'approved' }])),
  );
  await browser.route(
    (url) => url.pathname.startsWith('/payroll'),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path === '/payroll/runs' && method === 'POST') {
        state.run = 'draft';
        return json(route, run(state), 201);
      }
      if (path === '/payroll/runs')
        return json(route, page(state.run === 'none' ? [] : [run(state)]));
      if (path === '/payroll/runs/r1') return json(route, run(state));
      if (path === '/payroll/runs/r1/lines') return json(route, lines(state));
      if (path === '/payroll/runs/r1/payments') return json(route, []);
      if (path === '/payroll/runs/r1/finalize') {
        state.finalizeBody = request.postDataJSON() as Record<string, unknown>;
        state.run = 'finalized';
        return json(route, run(state));
      }
      if (path === '/payroll/runs/r1/payment-requests') {
        return json(route, { approvalDocId: null, amount: '3000.00', lineIds: ['l1', 'l2'] }, 201);
      }
      if (path === '/payroll/runs/r1/pay') {
        state.payBody = request.postDataJSON() as Record<string, unknown>;
        state.run = 'paid';
        return json(route, { id: 'p1' }, 201);
      }
      return json(route, {});
    },
  );
  return state;
}

test('payroll: an approved wage sheet becomes a finalized, fully paid run', async ({
  page: tab,
}) => {
  const state = await mockBackend(tab);
  await tab.goto('/');
  await tab.getByLabel('Email').fill('accountant@example.test');
  await tab.getByLabel('Password').fill('correct');
  await tab.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    tab.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();

  // Create the run from the approved period.
  await tab.getByRole('menuitem', { name: 'Payroll runs' }).click();
  await tab.getByRole('combobox', { name: 'Period' }).click();
  await tab.locator('.ant-select-item-option', { hasText: '2026-10' }).click();
  await tab.getByRole('button', { name: 'Create run' }).click();
  await expect.poll(() => state.run).toBe('draft');

  // Finalize: the cost difference is shown first.
  await tab.getByRole('link', { name: '2026-10' }).click();
  await expect(tab.getByText(/Difference: 100\.00/)).toBeVisible();
  await tab.getByRole('button', { name: 'Finalize run' }).click();
  await expect.poll(() => state.run).toBe('finalized');
  expect(state.finalizeBody).toMatchObject({ costDifferenceTreatment: 'spread_to_projects' });
  await expect(tab.getByRole('link', { name: 'PSL-2026-0001' })).toBeVisible();

  // Pay every unpaid line in cash from the bank account.
  await tab.getByRole('combobox', { name: 'Pay from account' }).click();
  await tab.locator('.ant-select-item-option', { hasText: 'BANK Synthetic Bank' }).click();
  await tab.getByRole('button', { name: 'Pay all unpaid' }).click();
  await expect.poll(() => state.run).toBe('paid');
  expect(state.payBody).toMatchObject({ method: 'cash', accountId: 'a1' });
  await expect(tab.getByText('Paid').first()).toBeVisible();
});
