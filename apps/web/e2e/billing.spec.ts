import { expect, test, type Page, type Route } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API that keeps the state of one invoice,
// so the last step of the lifecycle runs with no backend: the accepted quotation's stage is billed,
// the owner approves it, the accountant issues it and it gets its number.
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
    'billing.schedule.read',
    'billing.invoice.read',
    'billing.invoice.create',
    'billing.invoice.issue',
  ],
  scopes: [],
};

interface State {
  status: 'draft' | 'pending_approval' | 'approved' | 'issued';
}

const invoice = (state: State) => ({
  id: 'inv1',
  number: state.status === 'issued' ? 'INV-2026-0001' : null,
  seriesCode: state.status === 'issued' ? 'invoice' : null,
  authorityCode: state.status === 'draft' ? null : 'FBR',
  sourceType: 'project_stage',
  projectId: 'p1',
  partyId: 'c1',
  invoiceDate: '2026-11-18',
  dueDate: '2026-12-18',
  status: state.status,
  baseAmount: '1500000.00',
  advanceRecovery: '0.00',
  taxableBase: '1500000.00',
  taxTotal: '150000.00',
  grossTotal: '1650000.00',
  withholdingExpected: '0.00',
  registrationNumber: 'TEST-FBR-1',
  taxOnAdvanceAtReceipt: true,
  paymentDays: null,
  notes: null,
  issuedAt: null,
  version: 1,
  lines: [
    {
      lineNo: 1,
      scheduleId: 's1',
      description: 'Stage 1: Mobilization',
      amount: '1500000.00',
      supplyKind: 'services',
      nature: null,
    },
  ],
  approval:
    state.status === 'pending_approval'
      ? { status: 'pending', requestId: 'r1', currentRole: 'management' }
      : { status: 'none', requestId: null, currentRole: null },
  creditedBase: '0.00',
  taxSnapshot: null,
});

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

async function mockBackend(page: Page) {
  const state: State = { status: 'draft' };
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/me', (route) => route.fulfill({ json: profile }));
  await page.route(
    (url) => url.pathname.startsWith('/billing'),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path === '/billing/invoices' && method === 'GET') {
        return json(route, { items: [invoice(state)], total: 1, limit: 200, offset: 0 });
      }
      if (path === '/billing/invoices/inv1/preview') {
        return json(route, {
          baseAmount: '1500000.00',
          advanceRecovery: '0.00',
          taxableBase: '1500000.00',
          taxTotal: '150000.00',
          grossTotal: '1650000.00',
          withholdingExpected: '0.00',
          taxOnAdvanceAtReceipt: true,
          authorityCode: 'FBR',
          registrationNumber: 'TEST-FBR-1',
          dueDate: '2026-12-18',
        });
      }
      if (path === '/billing/invoices/inv1/submit') {
        state.status = 'pending_approval';
        return json(route, invoice(state));
      }
      if (path === '/billing/invoices/inv1/issue') {
        expect(request.postDataJSON()).toEqual({ version: 1 });
        state.status = 'issued';
        return json(route, invoice(state));
      }
      if (path === '/billing/invoices/inv1') return json(route, invoice(state));
      return json(route, []);
    },
  );
  return state;
}

test('stage invoice: draft, approval, issue and number', async ({ page }) => {
  const state = await mockBackend(page);
  await page.goto('/');
  await page.getByLabel('Email').fill('accountant@example.test');
  await page.getByLabel('Password').fill('correct');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();

  await page.getByRole('menuitem', { name: 'Invoices' }).click();
  await page.getByRole('link', { name: 'Draft' }).click();

  // The tax preview, then the owner's approval.
  await expect(page.getByText('Tax preview')).toBeVisible();
  await expect(page.getByText('1,650,000.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect.poll(() => state.status).toBe('pending_approval');
  await expect(
    page.getByText('This invoice is waiting for the owner to approve it.'),
  ).toBeVisible();
  state.status = 'approved';
  await page.reload();

  // Issuing locks the invoice and gives it its number.
  await page.getByRole('button', { name: 'Issue invoice' }).click();
  await expect(page.getByRole('heading', { name: /INV-2026-0001/ })).toBeVisible();
  expect(state.status).toBe('issued');
  await expect(page.getByRole('button', { name: 'Cancel invoice' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel by credit note' })).toHaveCount(0);
});
