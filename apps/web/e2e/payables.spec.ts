import { expect, test, type Page, type Route } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API that keeps the state of one purchase
// order with its receipt: the accountant bills the receipt, matches, submits, the owner approves
// (the mock flips the status), the bill is posted and paid by a bank transfer.
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
    'payables.bill.create',
    'payables.bill.read',
    'payables.bill.post',
    'payables.bill.override_match',
    'payables.payment.create',
    'payables.payment.pay',
    'payables.ledger.read',
  ],
  scopes: [],
};

const vendor = { id: 'v1', code: 'V-1', name: 'Synthetic Vendor', roles: ['vendor'], version: 1 };
const bank = {
  id: 'a1',
  code: 'BANK',
  name: 'Synthetic Bank',
  kind: 'bank',
  active: true,
  version: 1,
  balance: '0.00',
};

type BillStatus = 'draft' | 'matched' | 'pending_approval' | 'approved' | 'posted' | 'paid';
type PaymentStatus = 'draft' | 'approved' | 'paid';

interface State {
  bill: BillStatus | 'none';
  payment: PaymentStatus | 'none';
  billBody: Record<string, unknown> | undefined;
  paymentBody: Record<string, unknown> | undefined;
}

const bill = (state: State) => ({
  id: 'b1',
  number: 'VB-2026-0001',
  vendorPartyId: 'v1',
  vendorInvoiceNo: 'INV-77',
  billDate: '2026-11-18',
  dueDate: '2026-12-18',
  sourceType: 'purchase',
  status: state.bill === 'none' ? 'draft' : state.bill,
  supplyKind: 'goods',
  nature: '',
  locationId: null,
  baseAmount: '5000.00',
  taxTotal: '500.00',
  grossTotal: '5500.00',
  withholdingTotal: '0.00',
  netPayable: '5500.00',
  notes: null,
  matchOverrideReason: null,
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      grnLineId: 'gl1',
      description: 'Cement',
      quantity: '100',
      rate: '50',
      amount: '5000.00',
      costObjectType: 'project',
      costObjectId: 'pr1',
      costCodeId: 'c1',
    },
  ],
  matches:
    state.bill === 'draft' || state.bill === 'none'
      ? []
      : [
          {
            billLineId: 'l1',
            poRate: '50.0000',
            grnQty: '100.0000',
            billedQty: '100.0000',
            billedRate: '50.0000',
            qtyVariance: '0.0000',
            rateVariance: '0.0000',
            withinTolerance: true,
          },
        ],
  variances: [],
  allocated: state.bill === 'paid' ? '5500.00' : '0.00',
  outstanding: state.bill === 'paid' ? '0.00' : '5500.00',
  warnings: [],
  approval: { status: 'none', requestId: null, currentRole: null },
  version: 1,
});

const payment = (state: State) => ({
  id: 'p1',
  number: 'PV-2026-0001',
  vendorPartyId: 'v1',
  paymentDate: '2026-11-18',
  method: 'bank_transfer',
  amount: '5500.00',
  withholdingDeducted: '0.00',
  accountId: 'a1',
  chequeNumber: null,
  chequeDate: null,
  status: state.payment === 'none' ? 'draft' : state.payment,
  withholdingCertificateNo: null,
  allocations: [],
  version: 1,
});

const page = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

async function mockBackend(browser: Page) {
  const state: State = {
    bill: 'none',
    payment: 'none',
    billBody: undefined,
    paymentBody: undefined,
  };
  await browser.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await browser.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await browser.route('**/me', (route) => route.fulfill({ json: profile }));
  await browser.route(
    (url) => url.pathname.startsWith('/master/parties'),
    (route) => json(route, page([vendor])),
  );
  await browser.route(
    (url) => url.pathname.startsWith('/cashbook'),
    (route) => json(route, [bank]),
  );
  await browser.route(
    (url) => url.pathname.startsWith('/procurement'),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/procurement/purchase-orders') {
        return json(route, page([{ id: 'po1', number: 'PO-2026-0001' }]));
      }
      if (path === '/procurement/purchase-orders/po1') {
        return json(route, {
          id: 'po1',
          number: 'PO-2026-0001',
          vendorId: 'v1',
          projectId: 'pr1',
          status: 'approved',
          lines: [{ id: 'pl1', lineNo: 1, description: 'Cement', rate: '50', costCodeId: 'c1' }],
        });
      }
      if (path === '/procurement/grns') return json(route, page([{ id: 'g1' }]));
      if (path === '/procurement/grns/g1') {
        return json(route, {
          id: 'g1',
          number: 'GRN-2026-0001',
          poId: 'po1',
          receivedOn: '2026-11-18',
          status: 'posted',
          lines: [{ id: 'gl1', poLineId: 'pl1', acceptedQty: '100' }],
        });
      }
      return json(route, {});
    },
  );
  await browser.route(
    (url) => url.pathname.startsWith('/payables'),
    (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path === '/payables/bills' && method === 'POST') {
        state.billBody = request.postDataJSON() as Record<string, unknown>;
        state.bill = 'draft';
        return json(route, bill(state), 201);
      }
      if (path === '/payables/bills' && method === 'GET') {
        return json(route, page(state.bill === 'none' ? [] : [bill(state)]));
      }
      if (path === '/payables/bills/b1' && method === 'GET') return json(route, bill(state));
      if (path === '/payables/bills/b1/match') {
        state.bill = 'matched';
        return json(route, bill(state));
      }
      if (path === '/payables/bills/b1/submit') {
        state.bill = 'approved'; // the owner approves at once in this mock
        return json(route, bill(state));
      }
      if (path === '/payables/bills/b1/post') {
        state.bill = 'posted';
        return json(route, bill(state));
      }
      if (path === '/payables/vendors/v1/open-bills') {
        return json(route, [
          {
            billId: 'b1',
            number: 'VB-2026-0001',
            vendorInvoiceNo: 'INV-77',
            vendorPartyId: 'v1',
            billDate: '2026-11-18',
            dueDate: '2026-12-18',
            gross: '5500.00',
            withholdingTotal: '0.00',
            allocated: '0.00',
            withheld: '0.00',
            outstanding: '5500.00',
          },
        ]);
      }
      if (path === '/payables/payments' && method === 'POST') {
        state.paymentBody = request.postDataJSON() as Record<string, unknown>;
        state.payment = 'draft';
        return json(route, payment(state), 201);
      }
      if (path === '/payables/payments' && method === 'GET') {
        return json(route, page(state.payment === 'none' ? [] : [payment(state)]));
      }
      if (path === '/payables/payments/p1/submit') {
        state.payment = 'approved';
        return json(route, payment(state));
      }
      if (path === '/payables/payments/p1/pay') {
        state.payment = 'paid';
        state.bill = 'paid';
        return json(route, payment(state));
      }
      return json(route, {});
    },
  );
  return state;
}

test('payables: a receipt is billed, matched, approved, posted and paid', async ({ page: tab }) => {
  const state = await mockBackend(tab);
  await tab.goto('/');
  await tab.getByLabel('Email').fill('accountant@example.test');
  await tab.getByLabel('Password').fill('correct');
  await tab.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    tab.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();

  // The bill: pick the receipt line from the vendor's order.
  await tab.getByRole('menuitem', { name: 'Vendor bills' }).click();
  await tab.getByRole('button', { name: 'New bill' }).click();
  const vendorBox = tab.getByRole('combobox', { name: 'Vendor' });
  await vendorBox.click();
  await expect(
    tab.locator('.ant-select-item-option', { hasText: 'Synthetic Vendor' }),
  ).toBeVisible();
  await vendorBox.press('Enter');
  await tab.getByRole('textbox', { name: 'Vendor invoice no.' }).fill('INV-77');
  const order = tab.getByRole('combobox', { name: 'Purchase order' });
  await order.click();
  await tab.locator('.ant-select-item-option', { hasText: 'PO-2026-0001' }).click();
  await expect(tab.getByText('GRN-2026-0001 · Cement #1')).toBeVisible();
  await tab.getByRole('button', { name: 'Add' }).click();
  await tab.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => state.bill).toBe('draft');
  expect(state.billBody).toMatchObject({
    vendorPartyId: 'v1',
    vendorInvoiceNo: 'INV-77',
    sourceType: 'purchase',
    lines: [{ grnId: 'g1', grnLineId: 'gl1', quantity: '100', rate: '50' }],
  });

  // Match, submit (the owner approves in the mock), post.
  await tab.getByRole('button', { name: 'Match to order and receipt' }).click();
  await expect.poll(() => state.bill).toBe('matched');
  await expect(tab.getByText('Matches the order and receipt')).toBeVisible();
  await tab.getByRole('button', { name: 'Submit for approval' }).click();
  await expect.poll(() => state.bill).toBe('approved');
  await tab.getByRole('button', { name: 'Post the bill' }).click();
  await expect.poll(() => state.bill).toBe('posted');

  // The payment: allocate the bill, approve and pay it.
  await tab.getByRole('menuitem', { name: 'Vendor payments' }).click();
  await tab.getByRole('button', { name: 'New payment' }).click();
  const payVendor = tab.getByRole('combobox', { name: 'Vendor' });
  await payVendor.click();
  await expect(
    tab.locator('.ant-select-item-option', { hasText: 'Synthetic Vendor' }),
  ).toBeVisible();
  await payVendor.press('Enter');
  const account = tab.getByRole('combobox', { name: 'Account' });
  await account.click();
  await tab.locator('.ant-select-item-option', { hasText: 'BANK Synthetic Bank' }).click();
  await tab.getByRole('textbox', { name: 'Allocate VB-2026-0001' }).fill('5500');
  await tab.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => state.payment).toBe('draft');
  expect(state.paymentBody).toMatchObject({
    vendorPartyId: 'v1',
    accountId: 'a1',
    method: 'bank_transfer',
    allocations: [{ billId: 'b1', amount: '5500' }],
  });
  await tab.getByRole('menuitem', { name: 'Vendor payments' }).click();
  await tab.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => state.payment).toBe('approved');
  await tab.getByRole('button', { name: 'Pay', exact: true }).click();
  await expect.poll(() => state.payment).toBe('paid');
  await expect(tab.getByRole('cell', { name: 'Paid' })).toBeVisible();
  expect(state.bill).toBe('paid');
});
