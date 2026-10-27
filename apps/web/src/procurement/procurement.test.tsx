/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
   These tests read untyped JSON bodies of the HTTP API. */
import { procurementPermissions } from '@emporium/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { PurchaseOrder, Rfq } from './api';
import { ComparisonSheet } from './ComparisonSheet';
import { receiptLines } from './GrnPage';
import { emptyLine, linesProblem } from './LinesEditor';

type Reply = { status?: number; body: unknown };
let permissions: string[];
let order: PurchaseOrder;
const calls: { url: string; method: string; body: Record<string, any> | undefined }[] = [];
let refuse: Reply | undefined;

const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

const purchaseOrder = (over: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  id: 'po1',
  number: 'PO-2026-0001',
  revision: 1,
  vendorId: 'v1',
  requisitionId: null,
  destinationType: 'project',
  projectId: 'p1',
  storeId: null,
  orderDate: '2026-10-25',
  expectedDate: null,
  status: 'approved',
  total: '1500.00',
  terms: 'Net 30',
  version: 4,
  approval: { status: 'approved', requestId: 'r1', currentRole: null },
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      itemId: 'i1',
      quantity: '100.0000',
      unitCode: 'bag',
      rate: '10.0000',
      lineTotal: '1000.00',
      costCodeId: 'cc1',
      receivedQty: '40.0000',
    },
    {
      id: 'l2',
      lineNo: 2,
      itemId: 'i2',
      quantity: '50.0000',
      unitCode: 'kg',
      rate: '10.0000',
      lineTotal: '500.00',
      costCodeId: 'cc1',
      receivedQty: '0.0000',
    },
  ],
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  refuse = undefined;
  permissions = allPermissions;
  order = purchaseOrder();
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((fullUrl: string, init: RequestInit) => {
      const url = fullUrl.replace(/^https?:\/\/[^/]+/, '');
      if (url === '/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(profileOf(permissions)),
        });
      }
      const method = init.method ?? 'GET';
      calls.push({
        url,
        method,
        body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      });
      const reply = (): Reply => {
        if (method !== 'GET' && refuse !== undefined) return refuse;
        if (url.startsWith('/master/items')) {
          return {
            body: page([
              { id: 'i1', code: 'CEM', name: 'Cement' },
              { id: 'i2', code: 'STL', name: 'Steel' },
            ]),
          };
        }
        if (url.startsWith('/master/cost-codes')) {
          return { body: page([{ id: 'cc1', code: '100', name: 'Materials' }]) };
        }
        if (url.startsWith('/master/parties'))
          return { body: page([{ id: 'v1', name: 'Al Noor Traders' }]) };
        if (url.startsWith('/projects?')) {
          return { body: page([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall' }]) };
        }
        if (url === '/procurement/requisitions?limit=200') {
          return {
            body: page([
              {
                id: 'q1',
                number: 'REQ-2026-0001',
                projectId: 'p1',
                storeId: null,
                requiredBy: null,
                status: 'draft',
              },
            ]),
          };
        }
        if (url === '/procurement/requisitions' && method === 'POST') {
          return {
            status: 201,
            body: {
              id: 'q1',
              number: 'REQ-2026-0001',
              projectId: 'p1',
              lines: [],
              status: 'draft',
              approval: { status: 'none' },
              version: 1,
              note: '',
              requiredBy: null,
              storeId: null,
            },
          };
        }
        if (url.startsWith('/procurement/requisitions/q1/')) return { body: { id: 'q1' } };
        if (url === '/procurement/requisitions/q1') {
          return {
            body: {
              id: 'q1',
              number: 'REQ-2026-0001',
              projectId: 'p1',
              storeId: null,
              requiredBy: null,
              status: 'draft',
              note: 'Cement',
              version: 1,
              approval: { status: 'none', requestId: null, currentRole: null },
              lines: [
                {
                  id: 'ql1',
                  lineNo: 1,
                  itemId: 'i1',
                  description: '',
                  quantity: '10.0000',
                  unitCode: 'bag',
                  costCodeId: 'cc1',
                  estimatedRate: '1200.0000',
                  orderedQty: '0.0000',
                },
              ],
            },
          };
        }
        if (url.startsWith('/procurement/rfqs?')) return { body: page([]) };
        if (url === '/procurement/purchase-orders?limit=200') {
          return {
            body: page([
              {
                id: 'po1',
                number: order.number,
                vendorId: 'v1',
                total: order.total,
                status: order.status,
              },
            ]),
          };
        }
        if (url === '/procurement/open-po-lines') return { body: [] };
        if (url === '/procurement/po/po1/print-model') {
          return {
            body: {
              number: order.number,
              revision: 1,
              vendor: { name: 'Al Noor Traders', address: 'Saddar, Rawalpindi', phone: null },
              terms: '',
              total: order.total,
            },
          };
        }
        if (url.startsWith('/procurement/purchase-orders/po1/')) return { body: order };
        if (url === '/procurement/purchase-orders/po1') return { body: order };
        if (url === '/procurement/grns') {
          return {
            status: 201,
            body: { id: 'g1', number: 'GRN-2026-0001', poId: 'po1', status: 'posted' },
          };
        }
        return { body: page([]) };
      };
      const { status = 200, body } = reply();
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = (path: string) =>
  render(
    <AppProviders auth={fakeAuth()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

const withQuery = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {node}
  </QueryClientProvider>
);

const rfq: Rfq = {
  id: 'rfq1',
  requisitionId: 'q1',
  number: 'RFQ-2026-0001',
  status: 'open',
  vendorIds: ['a', 'b', 'c'],
  version: 1,
  quotes: [
    {
      id: 'qa',
      rfqId: 'rfq1',
      vendorId: 'a',
      validUntil: null,
      deliveryDays: null,
      terms: '',
      total: '1000.00',
      lines: [],
      version: 1,
    },
    {
      id: 'qb',
      rfqId: 'rfq1',
      vendorId: 'b',
      validUntil: null,
      deliveryDays: null,
      terms: '',
      total: '900.00',
      lines: [],
      version: 1,
    },
    {
      id: 'qc',
      rfqId: 'rfq1',
      vendorId: 'c',
      validUntil: null,
      deliveryDays: null,
      terms: '',
      total: '300.00',
      lines: [],
      version: 1,
    },
  ],
  selections: [{ requisitionLineId: 'ql1', quoteId: 'qb', vendorId: 'b', reason: null }],
  comparison: {
    lines: [
      {
        requisitionLineId: 'ql1',
        lineNo: 1,
        quantity: '10.0000',
        ranking: [
          { quoteId: 'qb', vendorId: 'b', rate: '90.0000', rank: 1 },
          { quoteId: 'qa', vendorId: 'a', rate: '100.0000', rank: 2 },
        ],
      },
    ],
    totals: [
      { quoteId: 'qb', vendorId: 'b', total: '900.00', complete: true, rank: 1 },
      { quoteId: 'qa', vendorId: 'a', total: '1000.00', complete: true, rank: 2 },
      { quoteId: 'qc', vendorId: 'c', total: '300.00', complete: false, rank: 3 },
    ],
  },
};
const vendorName = (id: string) => ({ a: 'Vendor A', b: 'Vendor B', c: 'Vendor C' })[id] ?? id;

describe('comparison sheet (T-9)', () => {
  const sheet = (onSelect = vi.fn(), readOnly = false) => {
    render(
      withQuery(
        <ComparisonSheet
          rfq={rfq}
          vendorName={vendorName}
          lineLabel={() => 'Cement'}
          readOnly={readOnly}
          onSelect={onSelect}
        />,
      ),
    );
    return onSelect;
  };

  it('ranks rates and totals and marks the lowest, the choice and quotes that are partial', () => {
    sheet();
    expect(screen.getByText('Lowest')).toBeVisible();
    expect(screen.getByText('Chosen')).toBeVisible();
    expect(screen.getByText('No quote')).toBeVisible();
    expect(screen.getByText('Does not quote every line')).toBeVisible();
    const totals = screen.getAllByRole('row').map((row) => row.textContent ?? '');
    expect(totals.some((text) => text.includes('Vendor B') && text.includes('900.00'))).toBe(true);
  });

  it('chooses the lowest rate straight away', async () => {
    const onSelect = vi.fn();
    render(
      withQuery(
        <ComparisonSheet
          rfq={{ ...rfq, selections: [] }}
          vendorName={vendorName}
          lineLabel={() => 'Cement'}
          onSelect={onSelect}
        />,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Choose Vendor B 1' }));
    expect(onSelect).toHaveBeenCalledWith('ql1', 'qb');
  });

  it('asks for a written reason before a dearer vendor is chosen (BR-2)', async () => {
    const onSelect = sheet();
    await userEvent.click(screen.getByRole('button', { name: 'Choose Vendor A 1' }));
    expect(screen.getByText('This vendor is not the lowest rate. Write the reason.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm choice' }));
    expect(screen.getByText('The reason cannot be empty.')).toBeVisible();
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Reason'), ' Closer to site ');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm choice' }));
    expect(onSelect).toHaveBeenCalledWith('ql1', 'qa', 'Closer to site');
    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();
  });

  it('can be dismissed and is read-only when closed', async () => {
    sheet();
    await userEvent.click(screen.getByRole('button', { name: 'Choose Vendor A 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();
  });

  it('shows no buttons when read-only', () => {
    sheet(vi.fn(), true);
    expect(screen.queryByRole('button', { name: /Choose/ })).not.toBeInTheDocument();
  });
});

describe('line helpers', () => {
  it('reports missing and incomplete lines', () => {
    expect(linesProblem([], false)).toBe('none');
    expect(linesProblem([emptyLine()], false)).toBe('incomplete');
    const line = { itemId: 'i1', quantity: '1', rate: '', costCodeId: 'cc1' };
    expect(linesProblem([line], false)).toBeNull();
    expect(linesProblem([line], true)).toBe('incomplete');
    expect(linesProblem([{ ...line, rate: '5' }], true)).toBeNull();
  });

  it('sends only the lines where something was counted', () => {
    expect(
      receiptLines(order, {
        l1: { accepted: ' 10 ', rejected: '' },
        l2: { accepted: '', rejected: '2' },
      }),
    ).toEqual([
      { poLineId: 'l1', acceptedQty: '10' },
      { poLineId: 'l2', acceptedQty: '0', rejectedQty: '2' },
    ]);
    expect(receiptLines(order, {})).toEqual([]);
  });
});

describe('receiving screen (T-9)', () => {
  it('needs a count and the challan photo, then posts the receipt', async () => {
    open('/procurement/receiving/po1');
    await screen.findByRole('heading', { name: 'Receive PO-2026-0001' });
    const post = screen.getByRole('button', { name: 'Post receipt' });
    await userEvent.click(post);
    expect(
      screen.getByText('Enter what was accepted or rejected on at least one line.'),
    ).toBeVisible();

    await userEvent.type(screen.getByLabelText('Accepted 1'), '20');
    await userEvent.type(screen.getByLabelText('Rejected 1'), '1');
    await userEvent.click(post);
    expect(screen.getByText('Take a photo of the delivery challan first.')).toBeVisible();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.type(screen.getByLabelText('Delivery challan number'), 'DC-77');
    const file = new File(['%PDF-1.7 challan'], 'challan.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('Photo of the delivery challan'), file);
    await userEvent.click(post);
    expect(await screen.findByText('Receipt GRN-2026-0001 posted.')).toBeVisible();
    const sent = calls.find((c) => c.method === 'POST' && c.url === '/procurement/grns');
    expect(sent?.body).toMatchObject({
      poId: 'po1',
      deliveryNoteRef: 'DC-77',
      lines: [{ poLineId: 'l1', acceptedQty: '20', rejectedQty: '1' }],
    });
    expect(sent?.body?.photos[0]).toMatchObject({ fileName: 'challan.pdf' });
    expect(sent?.body?.photos[0].contentBase64.length).toBeGreaterThan(10);
  });

  it('shows the explanation when the API refuses', async () => {
    refuse = { status: 422, body: { error: { code: 'over_receipt', message: 'no' } } };
    open('/procurement/receiving/po1');
    await screen.findByRole('heading', { name: 'Receive PO-2026-0001' });
    await userEvent.type(screen.getByLabelText('Accepted 2'), '999');
    await userEvent.upload(
      screen.getByLabelText('Photo of the delivery challan'),
      new File(['x'], 'c.png', { type: 'image/png' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    expect(
      await screen.findByText('The accepted quantity is more than the order allows.'),
    ).toBeVisible();
  });

  it('is closed to people who cannot receive', async () => {
    permissions = allPermissions.filter((p) => p !== procurementPermissions.grnCreate);
    open('/procurement/receiving/po1');
    expect(await screen.findByText(/permission|not allowed|403/i)).toBeVisible();
  });
});

describe('requisitions and orders', () => {
  it('lists requisitions and checks the form before creating', async () => {
    open('/procurement/requisitions');
    expect(await screen.findByRole('link', { name: 'REQ-2026-0001' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New requisition' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create requisition' }));
    expect(within(dialog).getByText('Choose a project or enter a store.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Store' }));
    await userEvent.type(within(dialog).getByLabelText('Store ID'), 'store-1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create requisition' }));
    expect(
      within(dialog).getByText('Every line needs an item, a quantity and a cost code.'),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('hides the new button without the create permission', async () => {
    permissions = allPermissions.filter((p) => p !== procurementPermissions.requisitionCreate);
    open('/procurement/requisitions');
    await screen.findByRole('link', { name: 'REQ-2026-0001' });
    expect(screen.queryByRole('button', { name: 'New requisition' })).not.toBeInTheDocument();
  });

  it('shows a requisition with its lines and submits it', async () => {
    open('/procurement/requisitions/q1');
    expect(await screen.findByRole('heading', { name: 'REQ-2026-0001' })).toBeVisible();
    expect(await screen.findByText('CEM Cement')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url === '/procurement/requisitions/q1/submit'),
      ).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/submit'))?.body).toEqual({ version: 1 });
  });

  it('lists orders and open lines', async () => {
    open('/procurement/purchase-orders');
    expect(await screen.findByRole('link', { name: 'PO-2026-0001' })).toBeVisible();
    expect(screen.getByText('Approved')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Open lines' }));
    expect(await screen.findByText('Still to come')).toBeVisible();
  });

  it('shows an approved order with the way into receiving, close and amend', async () => {
    open('/procurement/purchase-orders/po1');
    expect(await screen.findByRole('heading', { name: /PO-2026-0001/ })).toBeVisible();
    expect(await screen.findByText('Saddar, Rawalpindi')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Receive goods' })).toHaveAttribute(
      'href',
      '/procurement/receiving/po1',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Close order' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/procurement/purchase-orders/po1/close')).toBe(true),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Amend (new version)' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/procurement/purchase-orders/po1/amend')).toBe(true),
    );
    const amend = calls.find((c) => c.url.endsWith('/amend'))?.body;
    expect(amend).toMatchObject({ version: 4, vendorId: 'v1', projectId: 'p1' });
    expect(amend?.lines[0]).toMatchObject({ lineId: 'l1', quantity: '100.0000' });
  });

  it('lets a draft order be edited and submitted', async () => {
    order = purchaseOrder({ status: 'draft' });
    open('/procurement/purchase-orders/po1');
    await screen.findByRole('heading', { name: /PO-2026-0001/ });
    expect(screen.queryByRole('link', { name: 'Receive goods' })).not.toBeInTheDocument();
    await userEvent.clear(await screen.findByLabelText('Quantity 1'));
    await userEvent.type(screen.getByLabelText('Quantity 1'), '90');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body?.lines[0].quantity).toBe('90');
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/submit'))).toBe(true));
  });

  it('shows the explanation when an action is refused', async () => {
    refuse = { status: 422, body: { error: { code: 'po_has_receipts', message: 'no' } } };
    open('/procurement/purchase-orders/po1');
    await screen.findByRole('heading', { name: /PO-2026-0001/ });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByText('This order has receipts; close it instead.')).toBeVisible();
  });

  it('shows an RFQ with its comparison and the order buttons for chosen vendors', async () => {
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        if (path === '/procurement/rfqs/rfq1') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(rfq),
            text: () => Promise.resolve(''),
          });
        }
        return (original as unknown as (u: string, i: RequestInit) => Promise<Response>)(url, init);
      }),
    );
    open('/procurement/rfqs/rfq1');
    expect(await screen.findByRole('heading', { name: 'RFQ-2026-0001' })).toBeVisible();
    expect(await screen.findByText('Chosen')).toBeVisible();
    expect(screen.getByRole('button', { name: /Order from/ })).toBeVisible();
    expect(screen.getByText('Enter a vendor quote')).toBeVisible();
  });
});
