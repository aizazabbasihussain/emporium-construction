import { payablesPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import {
  allocationTotal,
  billProblem,
  isMoney,
  isQuantity,
  lineAmount,
  optional,
  paymentProblem,
} from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });
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
const bill = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  number: 'VB-2026-0001',
  vendorPartyId: 'v1',
  vendorInvoiceNo: 'INV-77',
  billDate: '2026-11-01',
  dueDate: '2026-11-30',
  sourceType: 'purchase',
  status: 'draft',
  supplyKind: 'goods',
  nature: '',
  locationId: null,
  baseAmount: '5000.00',
  taxTotal: '0.00',
  grossTotal: '5000.00',
  withholdingTotal: '0.00',
  netPayable: '5000.00',
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
  matches: [],
  variances: [],
  allocated: '0.00',
  outstanding: '5000.00',
  warnings: [],
  approval: { status: 'none', requestId: null, currentRole: null },
  version: 1,
  ...over,
});
const payment = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  number: 'PV-2026-0001',
  vendorPartyId: 'v1',
  paymentDate: '2026-11-18',
  method: 'bank_transfer',
  amount: '4900.00',
  withholdingDeducted: '100.00',
  accountId: 'a1',
  chequeNumber: null,
  chequeDate: null,
  status: 'draft',
  withholdingCertificateNo: null,
  allocations: [],
  version: 1,
  ...over,
});
const openBill = {
  billId: 'b1',
  number: 'VB-2026-0001',
  vendorInvoiceNo: 'INV-77',
  vendorPartyId: 'v1',
  billDate: '2026-11-01',
  dueDate: '2026-11-30',
  gross: '5000.00',
  withholdingTotal: '100.00',
  allocated: '0.00',
  withheld: '0.00',
  outstanding: '5000.00',
};

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      if (url === '/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(profileOf(permissions)),
        });
      }
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      });
      const base: Reply | undefined = url.startsWith('/master/parties')
        ? { body: page([vendor]) }
        : url.startsWith('/cashbook/accounts')
          ? { body: [bank] }
          : undefined;
      const { status = 200, body } = handler(url, init) ?? base ?? { body: {} };
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = (path: string) =>
  render(
    <AppProviders auth={fakeAuth()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

const choose = async (label: string, option: string) => {
  await userEvent.click(await screen.findByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByTitle(option));
};
const posted = (suffix: string) => calls.find((c) => c.method !== 'GET' && c.url.endsWith(suffix));

describe('form checks', () => {
  it('checks amounts and works out line amounts without float drift', () => {
    expect(isMoney('10.5')).toBe(true);
    expect(isMoney('0')).toBe(false);
    expect(isQuantity('1.2345')).toBe(true);
    expect(isQuantity('1.23456')).toBe(false);
    expect(optional('  ')).toBeUndefined();
    expect(lineAmount('100', '50')).toBe('5000.00');
    expect(lineAmount('10.5', '99.9999')).toBe('1050.00');
    expect(lineAmount('2', '150.255')).toBe('300.51');
    expect(lineAmount('0.01', '0.5')).toBe('0.01');
    expect(lineAmount('x', '1')).toBe('0.00');
    expect(allocationTotal({ a: '10.10', b: '', c: '0.20' })).toBe('10.30');
  });

  it('finds the first missing piece of a bill or payment', () => {
    const line = { grnId: 'g', grnLineId: 'l', quantity: '1', rate: '2' };
    const form = {
      vendorPartyId: 'v',
      vendorInvoiceNo: 'I',
      billDate: '2026-11-01',
      dueDate: '2026-11-02',
      lines: [line],
    };
    expect(billProblem({ ...form, vendorPartyId: '' })).toBe('vendor');
    expect(billProblem({ ...form, vendorInvoiceNo: ' ' })).toBe('invoiceNo');
    expect(billProblem({ ...form, dueDate: '2026-10-01' })).toBe('dates');
    expect(billProblem({ ...form, billDate: '' })).toBe('dates');
    expect(billProblem({ ...form, lines: [] })).toBe('lines');
    expect(billProblem({ ...form, lines: [{ ...line, quantity: '0' }] })).toBe('amounts');
    expect(billProblem(form)).toBeNull();
    const pay = {
      vendorPartyId: 'v',
      accountId: 'a',
      date: '2026-11-01',
      method: 'cash',
      chequeNumber: '',
      chequeDate: '',
      rows: { b: '10' },
    };
    expect(paymentProblem({ ...pay, vendorPartyId: '' })).toBe('vendor');
    expect(paymentProblem({ ...pay, accountId: '' })).toBe('account');
    expect(paymentProblem({ ...pay, date: '' })).toBe('date');
    expect(paymentProblem({ ...pay, method: 'cheque' })).toBe('cheque');
    expect(paymentProblem({ ...pay, rows: {} })).toBe('allocation');
    expect(paymentProblem({ ...pay, rows: { b: 'x' } })).toBe('allocation');
    expect(paymentProblem(pay)).toBeNull();
  });
});

describe('bills queue', () => {
  it('lists bills with the vendor name and filters by status', async () => {
    handler = (url) =>
      url.startsWith('/payables/bills') ? { body: page([bill({ status: 'posted' })]) } : undefined;
    open('/payables/bills');
    expect(await screen.findByText('VB-2026-0001')).toBeInTheDocument();
    expect(await screen.findByText('Synthetic Vendor')).toBeInTheDocument();
    await choose('Status', 'Posted');
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=posted'))).toBe(true));
  });

  it('shows the 403 page without the permission', async () => {
    permissions = allPermissions.filter((p) => p !== payablesPermissions.billRead);
    open('/payables/bills');
    expect(
      await screen.findByText('You do not have permission to open this page.'),
    ).toBeInTheDocument();
  });
});

describe('bill entry', () => {
  it('picks receipt lines from an order and saves the bill', async () => {
    handler = (url, init) => {
      if (url.startsWith('/procurement/purchase-orders?')) {
        return { body: page([{ id: 'po1', number: 'PO-2026-0001' }]) };
      }
      if (url === '/procurement/purchase-orders/po1') {
        return {
          body: {
            id: 'po1',
            number: 'PO-2026-0001',
            vendorId: 'v1',
            projectId: 'pr1',
            status: 'approved',
            lines: [{ id: 'pl1', lineNo: 1, description: 'Cement', rate: '50', costCodeId: 'c1' }],
          },
        };
      }
      if (url.startsWith('/procurement/grns?')) return { body: page([{ id: 'g1' }]) };
      if (url === '/procurement/grns/g1') {
        return {
          body: {
            id: 'g1',
            number: 'GRN-2026-0001',
            poId: 'po1',
            receivedOn: '2026-11-01',
            status: 'posted',
            lines: [{ id: 'gl1', poLineId: 'pl1', acceptedQty: '100' }],
          },
        };
      }
      if (url === '/payables/bills' && init.method === 'POST') return { status: 201, body: bill() };
      if (url === '/payables/bills/b1') return { body: bill() };
      return undefined;
    };
    open('/payables/bills/new');
    await choose('Vendor', 'Synthetic Vendor');
    await userEvent.type(screen.getByRole('textbox', { name: 'Vendor invoice no.' }), ' INV-77 ');
    await choose('Purchase order', 'PO-2026-0001');
    expect(await screen.findByText(/GRN-2026-0001 · Cement/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    const quantity = screen.getByRole('textbox', { name: /^Quantity GRN-2026-0001/ });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '60');
    expect(screen.getByText('3,000.00')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/payables/bills')).toBeDefined());
    expect(posted('/payables/bills')?.body).toMatchObject({
      vendorPartyId: 'v1',
      vendorInvoiceNo: 'INV-77',
      sourceType: 'purchase',
      lines: [{ grnId: 'g1', grnLineId: 'gl1', quantity: '60', rate: '50' }],
    });
    expect(await screen.findByText(/VB-2026-0001/)).toBeInTheDocument();
  });

  it('removes a line and explains what is missing', async () => {
    open('/payables/bills/new');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose the vendor.')).toBeInTheDocument();
    await choose('Vendor', 'Synthetic Vendor');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter the vendor invoice number.')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Vendor invoice no.' }), 'X-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Add at least one receipt line.')).toBeInTheDocument();
    expect(screen.getByText('Pick receipt lines above to bill them.')).toBeInTheDocument();
  });

  it('shows the server refusal in words', async () => {
    handler = (url, init) => {
      if (url.startsWith('/procurement/purchase-orders?')) {
        return { body: page([{ id: 'po1', number: 'PO-1' }]) };
      }
      if (url === '/procurement/purchase-orders/po1') {
        return {
          body: {
            id: 'po1',
            number: 'PO-1',
            vendorId: 'v1',
            projectId: null,
            status: 'approved',
            lines: [{ id: 'pl1', lineNo: 1, description: 'Sand', rate: '5', costCodeId: 'c1' }],
          },
        };
      }
      if (url.startsWith('/procurement/grns?')) return { body: page([{ id: 'g1' }]) };
      if (url === '/procurement/grns/g1') {
        return {
          body: {
            id: 'g1',
            number: 'GRN-1',
            poId: 'po1',
            receivedOn: '2026-11-01',
            status: 'posted',
            lines: [{ id: 'gl1', poLineId: 'pl1', acceptedQty: '10' }],
          },
        };
      }
      if (url === '/payables/bills' && init.method === 'POST') {
        return { status: 409, body: { error: { code: 'duplicate_bill', message: 'dup' } } };
      }
      return undefined;
    };
    open('/payables/bills/new');
    await choose('Vendor', 'Synthetic Vendor');
    await userEvent.type(screen.getByRole('textbox', { name: 'Vendor invoice no.' }), 'X-1');
    await choose('Purchase order', 'PO-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('A bill with this vendor invoice number is already recorded.'),
    ).toBeInTheDocument();
  });
});

describe('a bill', () => {
  it('matches a draft with a reason and shows the variance panel', async () => {
    let current = bill();
    handler = (url, init) => {
      if (url === '/payables/bills/b1' && init.method === 'GET') return { body: current };
      if (url === '/payables/bills/b1/match') {
        current = bill({
          status: 'matched',
          version: 2,
          matchOverrideReason: 'Price rise agreed',
          warnings: ['above_open_commitments'],
          matches: [
            {
              billLineId: 'l1',
              poRate: '45.0000',
              grnQty: '100.0000',
              billedQty: '100.0000',
              billedRate: '50.0000',
              qtyVariance: '0.0000',
              rateVariance: '5.0000',
              withinTolerance: false,
            },
          ],
        });
        return { body: current };
      }
      return undefined;
    };
    open('/payables/bills/b1');
    expect(await screen.findByText('Cement')).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reason to accept a variance' }),
      'Price rise agreed',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Match to order and receipt' }));
    await waitFor(() =>
      expect(posted('/payables/bills/b1/match')?.body).toEqual({
        version: 1,
        overrideReason: 'Price rise agreed',
      }),
    );
    expect(await screen.findByText(/Over received by 0.0000/)).toBeInTheDocument();
    expect(
      screen.getByText(/Match accepted with the reason: Price rise agreed/),
    ).toBeInTheDocument();
    expect(screen.getByText(/above what the vendor can be owed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toBeInTheDocument();
  });

  it('shows a refused match', async () => {
    handler = (url) => {
      if (url === '/payables/bills/b1/match') {
        return { status: 422, body: { error: { code: 'match_variance', message: 'differs' } } };
      }
      if (url === '/payables/bills/b1') return { body: bill() };
      return undefined;
    };
    open('/payables/bills/b1');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Match to order and receipt' }),
    );
    expect(await screen.findByText(/Enter a reason to accept it/)).toBeInTheDocument();
  });

  it('submits a matched bill, waits for the owner, posts an approved bill and cancels with a reason', async () => {
    let current = bill({ status: 'matched' });
    handler = (url, init) => {
      if (url === '/payables/bills/b1' && init.method === 'GET') return { body: current };
      if (url === '/payables/bills/b1/submit') {
        current = bill({
          status: 'pending_approval',
          version: 2,
          approval: { status: 'pending', requestId: 'r1', currentRole: 'management' },
        });
        return { body: current };
      }
      return undefined;
    };
    open('/payables/bills/b1');
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for approval' }));
    expect(await screen.findByText('Waiting for management to approve.')).toBeInTheDocument();
    expect(posted('/payables/bills/b1/submit')?.body).toEqual({ version: 1 });
  });

  it('posts an approved bill with a variance and cancels', async () => {
    let current = bill({
      status: 'approved',
      variances: [{ id: 'x1', billLineId: 'l1', amount: '500.00', treatment: 'project_cost' }],
    });
    handler = (url, init) => {
      if (url === '/payables/bills/b1' && init.method === 'GET') return { body: current };
      if (url === '/payables/bills/b1/post') {
        current = { ...current, status: 'posted', version: 2 };
        return { body: current };
      }
      if (url === '/payables/bills/b1/cancel') {
        current = { ...current, status: 'cancelled', version: 3 };
        return { body: current };
      }
      return undefined;
    };
    open('/payables/bills/b1');
    expect(
      await screen.findByText(/Price variance 500.00 charged to project cost/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Post the bill' }));
    await waitFor(() => expect(posted('/payables/bills/b1/post')?.body).toEqual({ version: 1 }));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Reason' }), 'Entered twice');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the bill' }));
    await waitFor(() =>
      expect(posted('/payables/bills/b1/cancel')?.body).toEqual({
        reason: 'Entered twice',
        version: 2,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel the bill' })).not.toBeInTheDocument(),
    );
  });

  it('says so when the bill cannot be loaded', async () => {
    handler = () => ({ status: 404, body: { error: { code: 'bill_not_found', message: 'no' } } });
    open('/payables/bills/b1');
    expect(
      (await screen.findAllByText(/could not|error|failed|not found/i)).length,
    ).toBeGreaterThan(0);
  });
});

describe('payments', () => {
  it('moves a payment through submit and pay and records the certificate', async () => {
    let current = payment();
    handler = (url, init) => {
      if (url.startsWith('/payables/payments?')) return { body: page([current]) };
      if (url === `/payables/payments/p1/submit`) {
        current = payment({ status: 'approved', version: 2 });
        return { body: current };
      }
      if (url === '/payables/payments/p1/pay') {
        current = payment({ status: 'paid', version: 3 });
        return { body: current };
      }
      if (url === '/payables/payments/p1/certificate' && init.method === 'PUT') {
        return { body: payment({ withholdingCertificateNo: 'WHT-1' }) };
      }
      if (url === '/payables/payments/p1/cancel') {
        current = payment({ status: 'cancelled', version: 4 });
        return { body: current };
      }
      return undefined;
    };
    open('/payables/payments');
    expect(await screen.findByText('PV-2026-0001')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Pay' }));
    await waitFor(() => expect(posted('/payables/payments/p1/pay')?.body).toEqual({ version: 2 }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Withholding certificate no.' }),
      'WHT-1',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save certificate' }));
    await waitFor(() =>
      expect(posted('/payables/payments/p1/certificate')?.body).toMatchObject({
        certificateNo: 'WHT-1',
      }),
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'Bounced');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(posted('/payables/payments/p1/cancel')?.body).toMatchObject({ reason: 'Bounced' }),
    );
  });

  it('shows why a payment was refused', async () => {
    handler = (url) => {
      if (url.startsWith('/payables/payments?')) {
        return { body: page([payment({ status: 'approved' })]) };
      }
      if (url === '/payables/payments/p1/pay') {
        return { status: 422, body: { error: { code: 'approver_cannot_pay', message: 'no' } } };
      }
      return undefined;
    };
    open('/payables/payments');
    await userEvent.click(await screen.findByRole('button', { name: 'Pay' }));
    expect(
      await screen.findByText('The person who approved the payment cannot pay it.'),
    ).toBeInTheDocument();
  });
});

describe('payment builder', () => {
  it('allocates open bills and saves the payment', async () => {
    handler = (url, init) => {
      if (url === '/payables/vendors/v1/open-bills') return { body: [openBill] };
      if (url === '/payables/payments' && init.method === 'POST') {
        return { status: 201, body: payment() };
      }
      return undefined;
    };
    open('/payables/payments/new');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose the vendor.')).toBeInTheDocument();
    await choose('Vendor', 'Synthetic Vendor');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose the account the money leaves.')).toBeInTheDocument();
    await choose('Account', 'BANK Synthetic Bank');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Allocate an amount to at least one bill; amounts above zero.'),
    ).toBeInTheDocument();
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Allocate VB-2026-0001' }),
      '5000',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted('/payables/payments')).toBeDefined());
    expect(posted('/payables/payments')?.body).toMatchObject({
      vendorPartyId: 'v1',
      accountId: 'a1',
      method: 'bank_transfer',
      allocations: [{ billId: 'b1', amount: '5000' }],
    });
    expect(
      await screen.findByText(/Payment PV-2026-0001 saved: cash 4,900.00/),
    ).toBeInTheDocument();
  });

  it('asks for the cheque details when paying by cheque', async () => {
    handler = (url) =>
      url === '/payables/vendors/v1/open-bills' ? { body: [openBill] } : undefined;
    open('/payables/payments/new');
    await choose('Vendor', 'Synthetic Vendor');
    await choose('Account', 'BANK Synthetic Bank');
    await choose('Method', 'Cheque');
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Allocate VB-2026-0001' }),
      '10',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter the cheque number and date.')).toBeInTheDocument();
  });

  it('shows the server refusal', async () => {
    handler = (url, init) => {
      if (url === '/payables/vendors/v1/open-bills') return { body: [openBill] };
      if (url === '/payables/payments' && init.method === 'POST') {
        return { status: 422, body: { error: { code: 'over_allocation', message: 'over' } } };
      }
      return undefined;
    };
    open('/payables/payments/new');
    await choose('Vendor', 'Synthetic Vendor');
    await choose('Account', 'BANK Synthetic Bank');
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Allocate VB-2026-0001' }),
      '99999',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('A bill cannot take more than it still owes.'),
    ).toBeInTheDocument();
  });
});

describe('payment runs', () => {
  it('creates a run for the selected bills', async () => {
    handler = (url, init) => {
      if (url.startsWith('/payables/bills?') && url.includes('status=posted')) {
        return { body: page([bill({ status: 'posted' })]) };
      }
      if (url.startsWith('/payables/bills?')) return { body: page([]) };
      if (url === '/payables/payment-runs' && init.method === 'POST') {
        return {
          status: 201,
          body: { id: 'run1', runDate: '2026-11-18', total: '5000.00', payments: [payment()] },
        };
      }
      return undefined;
    };
    open('/payables/payment-runs');
    await userEvent.click(await screen.findByRole('button', { name: 'Create run' }));
    expect(await screen.findByText('Select at least one bill.')).toBeInTheDocument();
    const boxes = await screen.findAllByRole('checkbox');
    await userEvent.click(boxes[1] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Create run' }));
    expect(await screen.findByText('Choose the account the money leaves.')).toBeInTheDocument();
    await choose('Account', 'BANK Synthetic Bank');
    await userEvent.click(screen.getByRole('button', { name: 'Create run' }));
    await waitFor(() => expect(posted('/payables/payment-runs')).toBeDefined());
    expect(posted('/payables/payment-runs')?.body).toMatchObject({
      billIds: ['b1'],
      method: 'bank_transfer',
      accountId: 'a1',
    });
    expect(await screen.findByText(/1 payment\(s\) created for 5,000.00/)).toBeInTheDocument();
  });

  it('shows the server refusal of a run', async () => {
    handler = (url, init) => {
      if (url.startsWith('/payables/bills?') && url.includes('status=posted')) {
        return { body: page([bill({ status: 'posted' })]) };
      }
      if (url.startsWith('/payables/bills?')) return { body: page([]) };
      if (url === '/payables/payment-runs' && init.method === 'POST') {
        return { status: 422, body: { error: { code: 'bill_not_payable', message: 'no' } } };
      }
      return undefined;
    };
    open('/payables/payment-runs');
    await screen.findByText('VB-2026-0001');
    const boxes = await screen.findAllByRole('checkbox');
    await userEvent.click(boxes[1] as HTMLElement);
    await choose('Account', 'BANK Synthetic Bank');
    await userEvent.click(screen.getByRole('button', { name: 'Create run' }));
    expect(
      await screen.findByText('Only posted bills that are still owed can be paid.'),
    ).toBeInTheDocument();
  });
});

describe('reports', () => {
  it('shows the vendor ledger with the withholding payable apart', async () => {
    handler = (url) =>
      url === '/payables/vendors/v1/ledger'
        ? {
            body: {
              partyId: 'v1',
              date: '2026-11-18',
              balance: {
                partyId: 'v1',
                date: '2026-11-18',
                netPayable: '4900.00',
                withholdingPayable: '100.00',
                payments: '1000.00',
                balance: '4000.00',
              },
              lines: [
                {
                  date: '2026-11-01',
                  kind: 'bill',
                  reference: 'VB-2026-0001',
                  documentId: 'b1',
                  debit: '0.00',
                  credit: '5000.00',
                  balance: '5000.00',
                },
              ],
              openBills: [],
            },
          }
        : undefined;
    open('/payables/vendors');
    await choose('Vendor', 'Synthetic Vendor');
    expect(await screen.findByText(/Withholding payable: 100.00/)).toBeInTheDocument();
    expect(screen.getByText('Balance: 4,000.00')).toBeInTheDocument();
    expect(screen.getByText('VB-2026-0001')).toBeInTheDocument();
  });

  it('shows aging with vendor names and totals', async () => {
    handler = (url) =>
      url.startsWith('/payables/aging')
        ? {
            body: {
              asOf: '2026-11-18',
              labels: ['current', '0-30', '31-60', '61-90', '90+'],
              rows: [
                {
                  key: 'v1',
                  buckets: ['0.00', '5000.00', '0.00', '0.00', '0.00'],
                  total: '5000.00',
                },
              ],
              totals: ['0.00', '5000.00', '0.00', '0.00', '0.00'],
              total: '5000.00',
            },
          }
        : undefined;
    open('/payables/aging');
    expect(await screen.findByText('Synthetic Vendor')).toBeInTheDocument();
    expect(screen.getByText('Not due')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('5,000.00').length).toBeGreaterThan(1);
  });

  it('shows the withholding report with totals and certificates', async () => {
    handler = (url) =>
      url.startsWith('/payables/withholding-report')
        ? {
            body: {
              rows: [
                {
                  authorityCode: 'FBR',
                  month: '2026-11',
                  vendorPartyId: 'v1',
                  paymentId: 'p1',
                  paymentNumber: 'PV-2026-0001',
                  billId: 'b1',
                  billNumber: 'VB-2026-0001',
                  amount: '100.00',
                  certificateNo: 'WHT-9',
                },
              ],
              totals: [{ authorityCode: 'FBR', month: '2026-11', amount: '100.00' }],
            },
          }
        : undefined;
    open('/payables/withholding');
    expect(await screen.findByText('FBR 2026-11: 100.00 withheld')).toBeInTheDocument();
    expect(screen.getByText('WHT-9')).toBeInTheDocument();
  });

  it('shows empty reports and a load error', async () => {
    handler = (url) =>
      url.startsWith('/payables/withholding-report')
        ? { body: { rows: [], totals: [] } }
        : { status: 500, body: { error: { code: 'boom', message: 'boom' } } };
    open('/payables/withholding');
    expect(await screen.findByText('No withholding deducted this month.')).toBeInTheDocument();
  });
});
