import { expect, test, type Page, type Route } from '@playwright/test';

// The browser talks to a mocked Supabase Auth and a mocked API that keeps the state of one
// requisition, one request for quotation, one order and one receipt, so the whole flow runs with no
// backend: requisition, approval, quotes, comparison, order, goods receipt.
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
    email: 'procurement@example.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-24T00:00:00Z',
  },
};

const profile = {
  id: '018f2222-0000-7000-8000-000000000004',
  email: 'procurement@example.test',
  fullName: 'Procurement Officer',
  locale: 'en',
  version: 1,
  roles: ['procurement', 'storekeeper'],
  permissions: [
    'procurement.requisition.create',
    'procurement.requisition.read',
    'procurement.rfq.manage',
    'procurement.po.create',
    'procurement.po.read',
    'procurement.grn.create',
    'procurement.grn.read',
  ],
  scopes: [],
};

const page_ = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });

function api(state: {
  requisition: string;
  quote: boolean;
  selected: boolean;
  po: boolean;
  received: boolean;
}) {
  const requisition = () => ({
    id: 'q1',
    number: 'REQ-2026-0001',
    projectId: null,
    storeId: 'store-1',
    requestedBy: 'u1',
    requiredBy: null,
    status: state.requisition,
    note: '',
    version: 1,
    approval: { status: 'none', requestId: null, currentRole: null },
    lines: [
      {
        id: 'ql1',
        lineNo: 1,
        itemId: 'i1',
        description: '',
        quantity: '100.0000',
        unitCode: 'bag',
        costCodeId: 'cc1',
        estimatedRate: null,
        orderedQty: state.po ? '100.0000' : '0.0000',
      },
    ],
  });
  const rfq = () => ({
    id: 'rfq1',
    requisitionId: 'q1',
    number: 'RFQ-2026-0001',
    status: 'open',
    vendorIds: ['v1'],
    version: 1,
    quotes: state.quote
      ? [
          {
            id: 'qt1',
            rfqId: 'rfq1',
            vendorId: 'v1',
            validUntil: null,
            deliveryDays: null,
            terms: '',
            total: '110000.00',
            lines: [{ requisitionLineId: 'ql1', rate: '1100.0000' }],
            version: 1,
          },
        ]
      : [],
    selections: state.selected
      ? [{ requisitionLineId: 'ql1', quoteId: 'qt1', vendorId: 'v1', reason: null }]
      : [],
    comparison: {
      lines: [
        {
          requisitionLineId: 'ql1',
          lineNo: 1,
          quantity: '100.0000',
          ranking: state.quote
            ? [{ quoteId: 'qt1', vendorId: 'v1', rate: '1100.0000', rank: 1 }]
            : [],
        },
      ],
      totals: state.quote
        ? [{ quoteId: 'qt1', vendorId: 'v1', total: '110000.00', complete: true, rank: 1 }]
        : [],
    },
  });
  const po = () => ({
    id: 'po1',
    number: 'PO-2026-0001',
    revision: 1,
    vendorId: 'v1',
    requisitionId: 'q1',
    destinationType: 'store',
    projectId: null,
    storeId: 'store-1',
    orderDate: '2026-10-25',
    expectedDate: null,
    status: state.received ? 'partly_received' : 'approved',
    total: '110000.00',
    terms: '',
    version: 2,
    approval: { status: 'approved', requestId: 'r1', currentRole: null },
    lines: [
      {
        id: 'pl1',
        lineNo: 1,
        itemId: 'i1',
        quantity: '100.0000',
        unitCode: 'bag',
        rate: '1100.0000',
        lineTotal: '110000.00',
        costCodeId: 'cc1',
        receivedQty: state.received ? '60.0000' : '0.0000',
      },
    ],
  });

  return async (route: Route) => {
    const request = route.request();
    if (request.resourceType() === 'document') return route.fallback();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });

    if (path === '/master/items')
      return json(page_([{ id: 'i1', code: 'CEM', name: 'Cement', active: true }]));
    if (path === '/master/cost-codes')
      return json(page_([{ id: 'cc1', code: '100', name: 'Materials' }]));
    if (path === '/master/units') return json(page_([]));
    if (path === '/master/parties') return json(page_([{ id: 'v1', name: 'Al Noor Traders' }]));
    if (path === '/projects') return json(page_([]));
    if (path === '/procurement/requisitions' && method === 'POST') return json(requisition(), 201);
    if (path === '/procurement/requisitions') return json(page_([requisition()]));
    if (path === '/procurement/requisitions/q1/submit') {
      state.requisition = 'approved'; // the owner approves in the inbox (H-09)
      return json(requisition());
    }
    if (path === '/procurement/requisitions/q1') return json(requisition());
    if (path === '/procurement/rfqs' && method === 'POST') return json(rfq(), 201);
    if (path === '/procurement/rfqs')
      return json(page_([{ id: 'rfq1', number: 'RFQ-2026-0001', status: 'open' }]));
    if (path === '/procurement/quotes') {
      state.quote = true;
      return json(rfq().quotes[0], 201);
    }
    if (path === '/procurement/rfqs/rfq1/select-vendor') {
      state.selected = true;
      return json(rfq());
    }
    if (path === '/procurement/rfqs/rfq1') return json(rfq());
    if (path === '/procurement/purchase-orders/from-rfq') {
      state.po = true;
      return json(po(), 201);
    }
    if (path === '/procurement/purchase-orders/po1') return json(po());
    if (path === '/procurement/po/po1/print-model') {
      return json({
        number: 'PO-2026-0001',
        revision: 1,
        vendor: { name: 'Al Noor Traders', address: null, phone: null },
        terms: '',
        total: '110000.00',
      });
    }
    if (path === '/procurement/grns' && method === 'POST') {
      const body = request.postDataJSON() as {
        lines: { acceptedQty: string }[];
        photos: unknown[];
      };
      expect(body.photos).toHaveLength(1);
      expect(body.lines).toEqual([{ poLineId: 'pl1', acceptedQty: '60' }]);
      state.received = true;
      return json({ id: 'g1', number: 'GRN-2026-0001', poId: 'po1', status: 'posted' }, 201);
    }
    return json(page_([]));
  };
}

async function mockBackend(page: Page) {
  const state = { requisition: 'draft', quote: false, selected: false, po: false, received: false };
  await page.route(`${SUPABASE}/auth/v1/token**`, (route) => route.fulfill({ json: session }));
  await page.route(`${SUPABASE}/auth/v1/logout**`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/me', (route) => route.fulfill({ json: profile }));
  await page.route(
    (url) =>
      url.pathname.startsWith('/procurement') ||
      url.pathname.startsWith('/master') ||
      url.pathname === '/projects',
    api(state),
  );
  return state;
}

test('requisition to goods receipt: ask, compare, order, receive', async ({ page }) => {
  const state = await mockBackend(page);
  await page.goto('/');
  await page.getByLabel('Email').fill('procurement@example.test');
  await page.getByLabel('Password').fill('correct');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Emporium Construction Operations' }),
  ).toBeVisible();

  // The requisition: a store replenishment of 100 bags of cement.
  await page.getByRole('menuitem', { name: 'Requisitions' }).click();
  await page.getByRole('button', { name: 'New requisition' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Store' }).check();
  await dialog.getByLabel('Store ID').fill('store-1');
  await dialog.getByRole('combobox', { name: 'Item 1' }).click();
  await page.getByTitle('CEM Cement').click();
  await dialog.getByLabel('Quantity 1').fill('100');
  await dialog.getByRole('combobox', { name: 'Cost code 1' }).click();
  await page.getByTitle('100 Materials').click();
  await dialog.getByRole('button', { name: 'Create requisition' }).click();
  await expect(page.getByRole('heading', { name: 'REQ-2026-0001' })).toBeVisible();

  // Approval (the owner decides in the inbox), then the request for quotation.
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect.poll(() => state.requisition).toBe('approved');
  await page.reload();
  await page.getByRole('combobox', { name: 'Vendors to ask' }).click();
  await page.getByTitle('Al Noor Traders').click();
  await page.getByRole('heading', { name: 'Request for quotation' }).click();
  await page.getByRole('button', { name: 'Ask for quotes' }).click();
  await expect(page.getByRole('heading', { name: 'RFQ-2026-0001' })).toBeVisible();

  // The quote, the comparison and the choice.
  await page.getByRole('combobox', { name: 'Vendor' }).click();
  await page.getByTitle('Al Noor Traders').click();
  await page.getByLabel('Rate 1').fill('1100');
  await page.getByRole('button', { name: 'Save quote' }).click();
  await expect(page.getByText('Lowest')).toBeVisible();
  await page.getByRole('button', { name: 'Choose Al Noor Traders 1' }).click();
  await expect(page.getByText('Chosen')).toBeVisible();

  // The order, then the goods at the gate.
  await page.getByRole('button', { name: 'Order from Al Noor Traders' }).click();
  await expect(page.getByRole('heading', { name: /PO-2026-0001/ })).toBeVisible();
  await page.getByRole('link', { name: 'Receive goods' }).click();
  await expect(page.getByRole('heading', { name: 'Receive PO-2026-0001' })).toBeVisible();
  await page.getByLabel('Accepted 1').fill('60');
  await page.getByLabel('Photo of the delivery challan').setInputFiles({
    name: 'challan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7 challan'),
  });
  await page.getByRole('button', { name: 'Post receipt' }).click();
  await expect(page.getByText('Receipt GRN-2026-0001 posted.')).toBeVisible();
  expect(state.received).toBe(true);
});
