import { subcontractsPermissions } from '@emporium/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import {
  backChargeProblem,
  billProblem,
  certificateProblem,
  isMoney,
  isPercent,
  isSignedMoney,
  optional,
  orderProblem,
  variationProblem,
} from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });
const contractor = {
  id: 'v1',
  code: 'S-1',
  name: 'Synthetic Builders',
  roles: ['subcontractor'],
  version: 1,
};
const project = { id: 'pr1', code: 'PRJ-1', name: 'Boundary wall', status: 'active', version: 1 };
const costCodes = [
  { id: 'c3', code: '300', name: 'Subcontractors', version: 1 },
  { id: 'c1', code: '100', name: 'Materials', version: 1 },
];
const header = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  number: 'SCO-2026-0001',
  projectId: 'pr1',
  partyId: 'v1',
  title: 'Brick work',
  status: 'active',
  contractAmount: '1000000.00',
  currentContractAmount: '1100000.00',
  certifiedAmount: '300000.00',
  committedAmount: '800000.00',
  startDate: '2026-11-01',
  endDate: '2026-12-31',
  version: 3,
  ...over,
});
const order = (over: Record<string, unknown> = {}) => ({
  ...header(),
  scopeText: 'Wall',
  costCodeId: 'c3',
  retentionPercent: '0.0000',
  closedOn: null,
  closeReason: null,
  variations: [
    {
      id: 'var1',
      seq: 1,
      amount: '100000.00',
      reason: 'Extra length',
      status: 'draft',
      decidedOn: null,
      decisionNote: null,
      version: 1,
    },
  ],
  approval: { status: 'none', requestId: null, currentRole: null },
  ...over,
});
const certificate = (over: Record<string, unknown> = {}) => ({
  id: 'ce1',
  number: 'SCC-2026-0001',
  workOrderId: 'w1',
  certificateDate: '2026-11-18',
  basis: 'percent_complete',
  cumulativePercent: '70.0000',
  cumulativeAmount: '770000.00',
  thisCertificateAmount: '470000.00',
  deductions: '20000.00',
  netCertified: '450000.00',
  status: 'draft',
  certifiedBy: null,
  certifiedOn: null,
  notes: null,
  billId: null,
  backCharges: [
    {
      id: 'bc1',
      workOrderId: 'w1',
      certificateId: 'ce1',
      description: 'Rework of plaster',
      amount: '20000.00',
      recoversCost: false,
      costCodeId: null,
      version: 1,
    },
  ],
  approval: { status: 'none', requestId: null, currentRole: null },
  version: 2,
  ...over,
});

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
        ? { body: page([contractor]) }
        : url.startsWith('/master/cost-codes')
          ? { body: page(costCodes) }
          : url.startsWith('/projects')
            ? { body: page([project]) }
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
const sent = (suffix: string) => calls.find((c) => c.method !== 'GET' && c.url.endsWith(suffix));
const type = async (label: string, text: string) =>
  userEvent.type(await screen.findByRole('textbox', { name: label }), text);

describe('form checks', () => {
  it('checks amounts and percents', () => {
    expect(isMoney('10.5')).toBe(true);
    expect(isMoney('0')).toBe(false);
    expect(isMoney('1.234')).toBe(false);
    expect(isSignedMoney('-5')).toBe(true);
    expect(isSignedMoney('0')).toBe(false);
    expect(isSignedMoney('x')).toBe(false);
    expect(isPercent('100')).toBe(true);
    expect(isPercent('100.5')).toBe(false);
    expect(isPercent('12.12345')).toBe(false);
    expect(optional('  ')).toBeUndefined();
    expect(optional(' a ')).toBe('a');
  });

  it('finds the first missing piece of each form', () => {
    const order = {
      projectId: 'p',
      partyId: 'v',
      title: 'T',
      contractAmount: '10',
      costCodeId: 'c',
      startDate: '2026-11-01',
      endDate: '2026-11-02',
    };
    expect(orderProblem({ ...order, projectId: '' })).toBe('project');
    expect(orderProblem({ ...order, partyId: '' })).toBe('party');
    expect(orderProblem({ ...order, title: ' ' })).toBe('title');
    expect(orderProblem({ ...order, contractAmount: '0' })).toBe('amount');
    expect(orderProblem({ ...order, costCodeId: '' })).toBe('costCode');
    expect(orderProblem({ ...order, endDate: '2026-10-01' })).toBe('dates');
    expect(orderProblem({ ...order, startDate: '' })).toBeNull();
    expect(orderProblem(order)).toBeNull();
    expect(certificateProblem({ date: '', basis: 'amount', cumulative: '1' })).toBe('date');
    expect(certificateProblem({ date: 'd', basis: 'percent_complete', cumulative: '101' })).toBe(
      'percent',
    );
    expect(certificateProblem({ date: 'd', basis: 'amount', cumulative: '0' })).toBe('amount');
    expect(certificateProblem({ date: 'd', basis: 'amount', cumulative: '5' })).toBeNull();
    expect(
      certificateProblem({ date: 'd', basis: 'percent_complete', cumulative: '30' }),
    ).toBeNull();
    const charge = { description: 'd', amount: '1', recoversCost: false, costCodeId: '' };
    expect(backChargeProblem({ ...charge, description: ' ' })).toBe('description');
    expect(backChargeProblem({ ...charge, amount: 'x' })).toBe('amount');
    expect(backChargeProblem({ ...charge, recoversCost: true })).toBe('costCode');
    expect(backChargeProblem(charge)).toBeNull();
    expect(variationProblem({ amount: '0', reason: 'r' })).toBe('amount');
    expect(variationProblem({ amount: '5', reason: ' ' })).toBe('reason');
    expect(variationProblem({ amount: '-5', reason: 'r' })).toBeNull();
    const bill = { vendorInvoiceNo: 'I', billDate: '2026-11-01', dueDate: '2026-11-02' };
    expect(billProblem({ ...bill, vendorInvoiceNo: ' ' })).toBe('invoiceNo');
    expect(billProblem({ ...bill, dueDate: '2026-10-01' })).toBe('dates');
    expect(billProblem({ ...bill, billDate: '' })).toBe('dates');
    expect(billProblem(bill)).toBeNull();
  });
});

describe('work orders queue', () => {
  it('lists orders with the subcontractor name and filters by status', async () => {
    handler = (url) =>
      url.startsWith('/subcontracts/work-orders') ? { body: page([header()]) } : undefined;
    open('/subcontracts/work-orders');
    expect(await screen.findByText('SCO-2026-0001')).toBeInTheDocument();
    expect(await screen.findByText('Synthetic Builders')).toBeInTheDocument();
    await choose('Status', 'Active');
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=active'))).toBe(true));
  });

  it('shows a dash instead of an amount the API withheld (BR-9)', async () => {
    handler = (url) =>
      url.startsWith('/subcontracts/work-orders')
        ? { body: page([header({ currentContractAmount: null, certifiedAmount: null })]) }
        : undefined;
    open('/subcontracts/work-orders');
    expect(await screen.findByText('SCO-2026-0001')).toBeInTheDocument();
    expect((await screen.findAllByText('—')).length).toBe(2);
  });

  it('shows the 403 page without the permission', async () => {
    permissions = allPermissions.filter((p) => p !== subcontractsPermissions.orderRead);
    open('/subcontracts/work-orders');
    expect(
      await screen.findByText('You do not have permission to open this page.'),
    ).toBeInTheDocument();
  });
});

describe('new work order', () => {
  it('shows what is missing, then saves the order with the subcontractors code preselected', async () => {
    handler = (url, init) =>
      url === '/subcontracts/work-orders' && init.method === 'POST'
        ? { status: 201, body: order() }
        : url === '/subcontracts/work-orders/w1'
          ? { body: order() }
          : url.endsWith('/certificates') || url.endsWith('/back-charges')
            ? { body: [] }
            : undefined;
    open('/subcontracts/work-orders/new');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose the project.')).toBeInTheDocument();
    await choose('Project', 'PRJ-1 Boundary wall');
    await choose('Subcontractor', 'Synthetic Builders');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a title.')).toBeInTheDocument();
    await type('Title', 'Brick work');
    await type('Contract amount', 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Enter the contract amount in rupees, above zero.'),
    ).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Contract amount' }));
    await type('Contract amount', '1000000');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('/subcontracts/work-orders')).toBeDefined());
    expect(sent('/subcontracts/work-orders')?.body).toEqual({
      projectId: 'pr1',
      partyId: 'v1',
      title: 'Brick work',
      contractAmount: '1000000',
      costCodeId: 'c3',
    });
    expect(await screen.findByText(/SCO-2026-0001 · Brick work/)).toBeInTheDocument();
  });

  it('reports a refusal of the API in the words of the module', async () => {
    handler = (url, init) =>
      url === '/subcontracts/work-orders' && init.method === 'POST'
        ? { status: 422, body: { error: { code: 'project_not_active', message: 'x' } } }
        : undefined;
    open('/subcontracts/work-orders/new');
    await choose('Project', 'PRJ-1 Boundary wall');
    await choose('Subcontractor', 'Synthetic Builders');
    await type('Title', 'Brick work');
    await type('Contract amount', '5');
    await userEvent.type(screen.getByLabelText('Scope of work'), 'Wall');
    await userEvent.type(screen.getByLabelText('Start date'), '2026-11-01');
    await userEvent.type(screen.getByLabelText('End date'), '2026-12-01');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The project is not active.')).toBeInTheDocument();
    expect(sent('/subcontracts/work-orders')?.body).toMatchObject({
      scopeText: 'Wall',
      startDate: '2026-11-01',
      endDate: '2026-12-01',
    });
  });
});

describe('a work order', () => {
  const orderHandler =
    (over: Record<string, unknown> = {}) =>
    (url: string, init: RequestInit) => {
      const reading = (init.method ?? 'GET') === 'GET';
      if (url === '/subcontracts/work-orders/w1' && reading) return { body: order(over) };
      if (url === '/subcontracts/work-orders/w1/certificates' && reading) {
        return { body: [certificate()] };
      }
      if (url === '/subcontracts/work-orders/w1/back-charges' && reading) {
        return { body: certificate().backCharges };
      }
      return reading ? undefined : { body: order() };
    };

  it('shows the figures, the variations, the certificates and the back-charges', async () => {
    handler = orderHandler();
    open('/subcontracts/work-orders/w1');
    expect(await screen.findByText(/SCO-2026-0001 · Brick work/)).toBeInTheDocument();
    expect(await screen.findByText('Extra length')).toBeInTheDocument();
    expect(await screen.findByText('SCC-2026-0001')).toBeInTheDocument();
    expect(await screen.findByText('Rework of plaster')).toBeInTheDocument();
    expect(screen.getByText(/1,100,000\.00/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ledger' })).toBeInTheDocument();
  });

  it('sends a draft for approval and cancels it', async () => {
    handler = orderHandler({
      status: 'draft',
      approval: { status: 'pending', requestId: 'r', currentRole: 'management' },
    });
    open('/subcontracts/work-orders/w1');
    await userEvent.click(await screen.findByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(sent('/subcontracts/work-orders/w1/submit')).toBeDefined());
    expect(sent('/subcontracts/work-orders/w1/submit')?.body).toEqual({ version: 3 });
    expect(await screen.findByText('Waiting for management')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(sent('/subcontracts/work-orders/w1/cancel')).toBeDefined());
  });

  it('closes an order with a reason', async () => {
    handler = orderHandler();
    open('/subcontracts/work-orders/w1');
    await type('Reason for closing before it is fully certified', 'Scope dropped');
    await userEvent.click(await screen.findByRole('button', { name: 'Close order' }));
    await waitFor(() => expect(sent('/subcontracts/work-orders/w1/close')).toBeDefined());
    expect(sent('/subcontracts/work-orders/w1/close')?.body).toEqual({
      version: 3,
      reason: 'Scope dropped',
    });
  });

  it('adds a variation after checking it and decides one', async () => {
    handler = orderHandler();
    open('/subcontracts/work-orders/w1');
    await userEvent.click(await screen.findByRole('button', { name: 'Add variation' }));
    expect(await screen.findByText('Enter an amount that is not zero.')).toBeInTheDocument();
    await type('Amount (negative reduces)', '-5000');
    await userEvent.click(screen.getByRole('button', { name: 'Add variation' }));
    expect(await screen.findByText('Enter the reason.')).toBeInTheDocument();
    await type('Reason', 'Shorter wall');
    await userEvent.click(screen.getByRole('button', { name: 'Add variation' }));
    await waitFor(() => expect(sent('/subcontracts/work-orders/w1/variations')).toBeDefined());
    expect(sent('/subcontracts/work-orders/w1/variations')?.body).toEqual({
      amount: '-5000',
      reason: 'Shorter wall',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sent('/subcontracts/variations/var1/approve')).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(sent('/subcontracts/variations/var1/reject')).toBeDefined());
  });

  it('adds a back-charge that recovers a cost with its cost code', async () => {
    handler = orderHandler();
    open('/subcontracts/work-orders/w1');
    await userEvent.click(await screen.findByRole('button', { name: 'Add back-charge' }));
    expect(await screen.findByText('Enter the description.')).toBeInTheDocument();
    await type('Description', 'Cement we supplied');
    await type('Amount', '20000');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Add back-charge' }));
    expect(
      await screen.findByText('Choose the cost code of the recovered cost.'),
    ).toBeInTheDocument();
    await choose('Cost code of the recovered cost', '100 Materials');
    await userEvent.click(screen.getByRole('button', { name: 'Add back-charge' }));
    await waitFor(() => expect(sent('/subcontracts/work-orders/w1/back-charges')).toBeDefined());
    expect(sent('/subcontracts/work-orders/w1/back-charges')?.body).toEqual({
      description: 'Cement we supplied',
      amount: '20000',
      recoversCost: true,
      costCodeId: 'c1',
    });
  });

  it('shows a refusal of a command and an error when the order cannot be loaded', async () => {
    handler = (url, init) =>
      init.method === 'POST'
        ? { status: 422, body: { error: { code: 'order_has_certified', message: 'x' } } }
        : orderHandler()(url, init);
    open('/subcontracts/work-orders/w1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
    expect(
      await screen.findByText('Work has been certified; close the work order instead.'),
    ).toBeInTheDocument();
  });

  it('reports a load error', async () => {
    handler = () => ({ status: 500, body: { error: { code: 'x', message: 'x' } } });
    open('/subcontracts/work-orders/w1');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('certificates', () => {
  const certHandler =
    (over: Record<string, unknown> = {}) =>
    (url: string, init: RequestInit) => {
      if (url === '/subcontracts/certificates/ce1') return { body: certificate(over) };
      if (url === '/subcontracts/work-orders/w1') return { body: order() };
      return init.method === 'POST' || init.method === 'PUT'
        ? { body: certificate(over) }
        : undefined;
    };

  it('creates a certificate from a cumulative percent after checking it', async () => {
    handler = (url, init) =>
      url === '/subcontracts/work-orders/w1/certificates' && init.method === 'POST'
        ? { status: 201, body: certificate() }
        : certHandler()(url, init);
    open('/subcontracts/work-orders/w1/certificates/new');
    expect(await screen.findByText(/300,000\.00 \/ 1,100,000\.00/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a percent from 0 to 100.')).toBeInTheDocument();
    await type('Cumulative', '70');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('/subcontracts/work-orders/w1/certificates')).toBeDefined());
    expect(sent('/subcontracts/work-orders/w1/certificates')?.body).toMatchObject({
      basis: 'percent_complete',
      cumulativePercent: '70',
    });
    expect(await screen.findByText('SCC-2026-0001')).toBeInTheDocument();
  });

  it('can start from a cumulative amount and shows a refusal of the API', async () => {
    handler = (url, init) =>
      url === '/subcontracts/work-orders/w1/certificates' && init.method === 'POST'
        ? { status: 422, body: { error: { code: 'over_certified', message: 'x' } } }
        : certHandler()(url, init);
    open('/subcontracts/work-orders/w1/certificates/new');
    await choose('Basis', 'Cumulative amount');
    await type('Cumulative', '2000000');
    await userEvent.type(screen.getByLabelText('Notes'), 'Final');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Certification cannot pass the contract amount.'),
    ).toBeInTheDocument();
    expect(sent('/subcontracts/work-orders/w1/certificates')?.body).toMatchObject({
      basis: 'amount',
      cumulativeAmount: '2000000',
      notes: 'Final',
    });
  });

  it('shows cumulative against the previous with its deductions, and edits and submits a draft', async () => {
    handler = certHandler();
    open('/subcontracts/certificates/ce1');
    expect(await screen.findByText('SCC-2026-0001')).toBeInTheDocument();
    expect(await screen.findByText('Certified so far')).toBeInTheDocument();
    expect(screen.getByText(/70\.0000% · 770,000\.00/)).toBeInTheDocument();
    expect(screen.getByText('450,000.00')).toBeInTheDocument();
    expect(screen.getByText('Rework of plaster')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const cumulative = await screen.findByRole('textbox', { name: 'Cumulative' });
    await userEvent.clear(cumulative);
    await userEvent.type(cumulative, '150');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a percent from 0 to 100.')).toBeInTheDocument();
    await userEvent.clear(cumulative);
    await userEvent.type(cumulative, '75');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      cumulativePercent: '75',
      version: 2,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(sent('/subcontracts/certificates/ce1/submit')).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel certificate' }));
    await waitFor(() => expect(sent('/subcontracts/certificates/ce1/cancel')).toBeDefined());
  });

  it('edits an amount-based certificate with notes', async () => {
    handler = certHandler({ basis: 'amount', notes: 'First', cumulativeAmount: '500000.00' });
    open('/subcontracts/certificates/ce1');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('textbox', { name: 'Cumulative' })).toHaveValue('500000.00');
    expect(screen.getByLabelText('Notes')).toHaveValue('First');
  });

  it('creates a bill from a certified certificate and links to it', async () => {
    handler = (url, init) =>
      url === '/subcontracts/certificates/ce1/bill' && init.method === 'POST'
        ? {
            status: 201,
            body: {
              certificate: certificate({ status: 'certified' }),
              bill: { id: 'b1', number: 'VB-1' },
            },
          }
        : certHandler({ status: 'certified' })(url, init);
    open('/subcontracts/certificates/ce1');
    await userEvent.click(await screen.findByRole('button', { name: 'Create bill' }));
    expect(await screen.findByText('Enter the invoice number.')).toBeInTheDocument();
    await type('Subcontractor invoice number', 'SUB-77');
    await userEvent.click(screen.getByRole('button', { name: 'Create bill' }));
    await waitFor(() => expect(sent('/subcontracts/certificates/ce1/bill')).toBeDefined());
    expect(sent('/subcontracts/certificates/ce1/bill')?.body).toMatchObject({
      vendorInvoiceNo: 'SUB-77',
    });
  });

  it('hides the bill form of a billed certificate, shows its bill link and withheld amounts', async () => {
    handler = certHandler({
      status: 'billed',
      billId: 'b1',
      cumulativeAmount: null,
      thisCertificateAmount: null,
      deductions: null,
      netCertified: null,
      backCharges: [],
      approval: { status: 'pending', requestId: 'r', currentRole: 'project_manager' },
    });
    open('/subcontracts/certificates/ce1');
    expect(await screen.findByRole('link', { name: 'Open the bill' })).toHaveAttribute(
      'href',
      '/payables/bills/b1',
    );
    expect(screen.queryByRole('button', { name: 'Create bill' })).toBeNull();
    expect(screen.getByText('No back-charges.')).toBeInTheDocument();
    expect((await screen.findAllByText(/—/)).length).toBeGreaterThan(0);
  });

  it('refuses a malformed bill date and reports a load error', async () => {
    handler = certHandler({ status: 'certified' });
    open('/subcontracts/certificates/ce1');
    await type('Subcontractor invoice number', 'SUB-1');
    const due = await screen.findByLabelText('Due date');
    await userEvent.clear(due);
    await userEvent.click(screen.getByRole('button', { name: 'Create bill' }));
    expect(await screen.findByText('Check the bill and due dates.')).toBeInTheDocument();
  });

  it('reports a certificate that cannot be loaded', async () => {
    handler = () => ({ status: 500, body: { error: { code: 'x', message: 'x' } } });
    open('/subcontracts/certificates/ce1');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('ledger and statement', () => {
  it('shows contract, certified, billed and paid with the certificates', async () => {
    handler = (url) =>
      url === '/subcontracts/work-orders/w1/ledger'
        ? {
            body: {
              workOrderId: 'w1',
              number: 'SCO-2026-0001',
              contract: '1100000.00',
              certified: '770000.00',
              deductions: '20000.00',
              billed: '450000.00',
              paid: '100000.00',
              committed: '330000.00',
              certificates: [
                {
                  certificateId: 'ce1',
                  number: 'SCC-2026-0001',
                  status: 'billed',
                  gross: '470000.00',
                  deductions: '20000.00',
                  net: '450000.00',
                  paid: '100000.00',
                },
              ],
            },
          }
        : undefined;
    open('/subcontracts/work-orders/w1/ledger');
    expect(await screen.findByText(/Work order ledger · SCO-2026-0001/)).toBeInTheDocument();
    expect(screen.getByText('1,100,000.00')).toBeInTheDocument();
    expect(screen.getByText('330,000.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SCC-2026-0001' })).toBeInTheDocument();
  });

  it('reports a ledger that cannot be loaded and the 403 page without the amount permission', async () => {
    handler = () => ({ status: 500, body: { error: { code: 'x', message: 'x' } } });
    open('/subcontracts/work-orders/w1/ledger');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });

  it('shows the statement of a chosen subcontractor with totals', async () => {
    handler = (url) =>
      url === '/subcontracts/subcontractors/v1/statement'
        ? {
            body: {
              partyId: 'v1',
              orders: [
                {
                  workOrderId: 'w1',
                  number: 'SCO-2026-0001',
                  title: 'Brick work',
                  status: 'active',
                  contract: '100.00',
                  certified: '50.00',
                  deductions: '0.00',
                  billed: '40.00',
                  paid: '10.00',
                },
              ],
              totals: {
                contract: '100.00',
                certified: '50.00',
                deductions: '0.00',
                billed: '40.00',
                paid: '10.00',
              },
            },
          }
        : undefined;
    open('/subcontracts/statement');
    await choose('Subcontractor', 'Synthetic Builders');
    expect(await screen.findByText('SCO-2026-0001')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('shows the 403 page without the amount permission', async () => {
    permissions = allPermissions.filter((p) => p !== subcontractsPermissions.amountRead);
    open('/subcontracts/statement');
    expect(
      await screen.findByText('You do not have permission to open this page.'),
    ).toBeInTheDocument();
  });
});
