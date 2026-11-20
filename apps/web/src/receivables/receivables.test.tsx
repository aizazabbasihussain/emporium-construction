import { receivablesPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import {
  allocatedTotal,
  isAmountOrBlank,
  isPositiveAmount,
  optional,
  receiptProblem,
} from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 100, offset: 0 });
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
const invoice = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});
const receipt = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  number: 'RV-2026-0001',
  partyId: 'p1',
  receiptDate: '2026-11-18',
  method: 'bank_transfer',
  amount: '1000.00',
  status: 'cleared',
  withheldAmount: '0.00',
  unallocated: '0.00',
  allocations: [],
  withholdingFlags: [],
  version: 1,
  ...over,
});
const pdc = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  receiptId: 'r1',
  partyId: 'p1',
  chequeNumber: 'CH-100',
  bankName: 'Synthetic Bank',
  drawer: null,
  chequeDate: '2026-11-20',
  amount: '500.00',
  status: 'received',
  version: 1,
  ...over,
});
const register = (items: unknown[]) => ({
  items,
  upcoming: items.filter((p) => (p as { status: string }).status === 'received'),
  totalInHand: '500.00',
  byStatus: {},
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
        ? { body: page([party]) }
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

describe('form checks', () => {
  it('checks amounts and optional text', () => {
    expect(isPositiveAmount('10.5')).toBe(true);
    expect(isPositiveAmount('0')).toBe(false);
    expect(isAmountOrBlank('')).toBe(true);
    expect(isAmountOrBlank('x')).toBe(false);
    expect(optional('  ')).toBeUndefined();
    expect(allocatedTotal([{ invoiceId: 'a', amount: '10.10', withheld: '0.20' }])).toBe('10.30');
  });

  it('finds the first problem of a receipt', () => {
    const ok = {
      partyId: 'p1',
      accountId: 'a2',
      date: '2026-11-18',
      amount: '100',
      withheld: '',
      cheque: false,
      chequeNumber: '',
      bankName: '',
      chequeDate: '',
      rows: [{ invoiceId: 'i1', amount: '100', withheld: '' }],
    };
    expect(receiptProblem(ok)).toBeNull();
    expect(receiptProblem({ ...ok, partyId: '' })).toBe('customer');
    expect(receiptProblem({ ...ok, accountId: '' })).toBe('account');
    expect(receiptProblem({ ...ok, date: '' })).toBe('date');
    expect(receiptProblem({ ...ok, amount: '0' })).toBe('amount');
    expect(receiptProblem({ ...ok, withheld: 'x' })).toBe('amount');
    expect(receiptProblem({ ...ok, rows: [{ invoiceId: 'i1', amount: '90', withheld: '' }] })).toBe(
      'allocation',
    );
    expect(
      receiptProblem({
        ...ok,
        rows: [{ invoiceId: 'i1', amount: '100', withheld: '10' }],
        withheld: '10',
      }),
    ).toBeNull();
    // Nothing allocated: the whole receipt stays as customer credit.
    expect(receiptProblem({ ...ok, rows: [] })).toBeNull();
    const cheque = {
      ...ok,
      accountId: '',
      cheque: true,
      chequeNumber: '1',
      bankName: 'B',
      chequeDate: '2026-11-20',
    };
    expect(receiptProblem(cheque)).toBeNull();
    expect(receiptProblem({ ...cheque, chequeNumber: ' ' })).toBe('cheque');
    expect(receiptProblem({ ...cheque, bankName: '' })).toBe('cheque');
    expect(receiptProblem({ ...cheque, chequeDate: '' })).toBe('cheque');
  });
});

describe('receipt entry', () => {
  it('suggests the allocation, checks the form and records the receipt', async () => {
    handler = (url, init) => {
      if (url === '/receivables/customers/p1/open-invoices') {
        return {
          body: [
            invoice(),
            invoice({ invoiceId: 'i2', number: 'INV-2026-0002', dueDate: '2026-12-01' }),
          ],
        };
      }
      if (url.startsWith('/receivables/customers/p1/suggest-allocation')) {
        return { body: [{ invoiceId: 'i1', amount: '600.00' }] };
      }
      if (url === '/receivables/receipts' && init.method === 'POST') {
        return {
          body: receipt({
            unallocated: '100.00',
            withholdingFlags: [
              {
                invoiceId: 'i1',
                expected: '0.00',
                actual: '50.00',
                difference: '50.00',
                flagged: true,
              },
            ],
          }),
        };
      }
      return undefined;
    };
    open('/receivables/receipts/new');
    await choose('Customer', 'Synthetic Client');
    expect(await screen.findByText('INV-2026-0002')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose the account that takes the money.')).toBeInTheDocument();
    await choose('Account', 'BANK Synthetic Bank');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter an amount above zero.')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox', { name: 'Amount' }), '600');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest allocation' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Allocate INV-2026-0001' })).toHaveValue('600.00'),
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Allocate INV-2026-0002' }), '40');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('The allocations must add up to the receipt plus the tax withheld.'),
    ).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Allocate INV-2026-0002' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Reference' }), 'TRX-9');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Receipt RV-2026-0001 recorded.')).toBeInTheDocument();
    expect(screen.getByText(/Left as customer credit/)).toBeInTheDocument();
    expect(screen.getByText(/differs from the expected amount by 50.00/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      partyId: 'p1',
      method: 'bank_transfer',
      amount: '600',
      accountId: 'a2',
      reference: 'TRX-9',
      allocations: [{ kind: 'invoice', invoiceId: 'i1', amount: '600.00' }],
    });
  });

  it('asks for the cheque details of a post-dated cheque and sends withholding lines', async () => {
    handler = (url, init) => {
      if (url === '/receivables/customers/p1/open-invoices') return { body: [invoice()] };
      if (url === '/receivables/receipts' && init.method === 'POST')
        return { body: receipt({ method: 'pdc', status: 'pending_clearing' }) };
      return undefined;
    };
    open('/receivables/receipts/new');
    await choose('Customer', 'Synthetic Client');
    await choose('Method', 'Post-dated cheque');
    expect(screen.queryByRole('combobox', { name: 'Account' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount' }), '950');
    await userEvent.type(screen.getByRole('textbox', { name: 'Tax withheld by the client' }), '50');
    await userEvent.type(screen.getByRole('textbox', { name: 'Withholding certificate' }), 'CPR-5');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter the cheque number, bank and date.')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Cheque number' }), 'CH-7');
    await userEvent.type(screen.getByRole('textbox', { name: 'Bank' }), 'HBL');
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Allocate INV-2026-0001' }),
      '950',
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Withheld INV-2026-0001' }), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      method: 'pdc',
      withheldAmount: '50',
      withholdingCertificateRef: 'CPR-5',
      cheque: { chequeNumber: 'CH-7', bankName: 'HBL' },
      allocations: [
        { kind: 'invoice', invoiceId: 'i1', amount: '950' },
        { kind: 'withholding', invoiceId: 'i1', amount: '50' },
      ],
    });
  });

  it('shows the reason the server gives when a rule is broken', async () => {
    handler = (url, init) => {
      if (url === '/receivables/customers/p1/open-invoices') return { body: [invoice()] };
      if (url === '/receivables/receipts' && init.method === 'POST') {
        return { status: 422, body: { error: { code: 'over_allocation', message: 'too much' } } };
      }
      return undefined;
    };
    open('/receivables/receipts/new');
    await choose('Customer', 'Synthetic Client');
    await choose('Account', 'BANK Synthetic Bank');
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount' }), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('An invoice cannot take more than it still owes.'),
    ).toBeInTheDocument();
  });
});

describe('cheque register', () => {
  it('lists cheques and runs a cheque from deposit to clearing', async () => {
    handler = (url, init) => {
      if (url.startsWith('/receivables/pdcs') && (init.method ?? 'GET') === 'GET') {
        return {
          body: register([pdc(), pdc({ id: 'c2', chequeNumber: 'CH-200', status: 'deposited' })]),
        };
      }
      if (init.method === 'POST') return { body: pdc({ status: 'deposited' }) };
      return undefined;
    };
    open('/receivables/pdcs');
    expect(await screen.findByText('CH-200')).toBeInTheDocument();
    expect(screen.getByText('500.00', { selector: 'strong' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Deposit' }));
    const modal = await screen.findByRole('dialog');
    await choose('Deposit into', 'BANK Synthetic Bank');
    await userEvent.type(
      within(modal).getByRole('textbox', { name: 'Reason for depositing before the cheque date' }),
      'Client agreed',
    );
    await userEvent.click(within(modal).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/receivables/pdcs/c1/deposit')).toBe(true),
    );
    expect(calls.find((c) => c.url === '/receivables/pdcs/c1/deposit')?.body).toEqual({
      accountId: 'a2',
      version: 1,
      overrideReason: 'Client agreed',
    });

    await userEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0] as HTMLElement);
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/receivables/pdcs/c2/clear')).toBe(true),
    );
  });

  it('bounces with a reason, returns and replaces a cheque and shows server errors', async () => {
    handler = (url, init) => {
      if (url.startsWith('/receivables/pdcs') && (init.method ?? 'GET') === 'GET') {
        return {
          body: register([
            pdc({ status: 'deposited' }),
            pdc({ id: 'c3', chequeNumber: 'CH-300', status: 'bounced' }),
          ]),
        };
      }
      if (url.endsWith('/bounce')) {
        return {
          status: 422,
          body: { error: { code: 'pdc_transition_forbidden', message: 'no' } },
        };
      }
      return url.startsWith('/receivables/') ? { body: pdc() } : undefined;
    };
    open('/receivables/pdcs');
    await screen.findByText('CH-300');
    await userEvent.click(screen.getByRole('button', { name: 'Bounce' }));
    const modal = await screen.findByRole('dialog');
    await userEvent.type(
      within(modal).getByRole('textbox', { name: 'Reason it bounced' }),
      'No funds',
    );
    await userEvent.click(within(modal).getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('The cheque cannot be moved that way from its current status.'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/receivables/pdcs/c1/bounce')?.body).toEqual({
      reason: 'No funds',
      version: 1,
    });
    await userEvent.click(within(modal).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(screen.getByRole('button', { name: 'Return' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/receivables/pdcs/c3/return')).toBe(true),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
    const replace = await screen.findByRole('dialog');
    await userEvent.type(within(replace).getByRole('textbox', { name: 'Cheque number' }), 'CH-301');
    await userEvent.type(within(replace).getByRole('textbox', { name: 'Bank' }), 'MCB');
    await userEvent.click(within(replace).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/receivables/pdcs/c3/replace')).toBe(true),
    );
    expect(calls.find((c) => c.url === '/receivables/pdcs/c3/replace')?.body).toMatchObject({
      cheque: { chequeNumber: 'CH-301', bankName: 'MCB' },
      version: 1,
    });
  });

  it('filters by status and hides the actions without the permission', async () => {
    permissions = [receivablesPermissions.ledgerRead];
    handler = (url) =>
      url.startsWith('/receivables/pdcs') ? { body: register([pdc()]) } : undefined;
    open('/receivables/pdcs');
    await screen.findByText('CH-100');
    expect(screen.queryByRole('button', { name: 'Deposit' })).not.toBeInTheDocument();
    await choose('Status', 'Cleared');
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/receivables/pdcs?status=cleared')).toBe(true),
    );
  });
});

describe('customer ledger and statement', () => {
  it('shows the balance with the credit, open invoices, receipts and the statement', async () => {
    handler = (url) => {
      if (url === '/receivables/customers/p1/ledger') {
        return {
          body: {
            balance: {
              partyId: 'p1',
              date: '2026-11-18',
              invoiced: '5000.00',
              credited: '100.00',
              receipts: '1000.00',
              withholding: '50.00',
              adjustments: '0.00',
              balance: '3850.00',
              unallocatedReceipts: '25.00',
              unappliedAdvances: '0.00',
              credit: '25.00',
            },
            openInvoices: [invoice()],
            receipts: page([receipt()]),
          },
        };
      }
      if (url.startsWith('/receivables/customers/p1/statement')) {
        return {
          body: {
            partyId: 'p1',
            from: '2026-01-01',
            to: '2026-11-18',
            opening: '0.00',
            closing: '3850.00',
            lines: [
              {
                date: '2026-11-01',
                kind: 'invoice',
                reference: 'INV-2026-0001',
                debit: '5000.00',
                credit: '0.00',
                balance: '5000.00',
              },
              {
                date: '2026-11-18',
                kind: 'receipt',
                reference: 'RV-2026-0001',
                debit: '0.00',
                credit: '1000.00',
                balance: '4000.00',
              },
            ],
          },
        };
      }
      return undefined;
    };
    const print = vi.fn();
    vi.stubGlobal('print', print);
    open('/receivables/customers');
    await choose('Customer', 'Synthetic Client');
    expect(await screen.findByLabelText('Balance')).toHaveTextContent('3,850.00');
    expect(screen.getByLabelText('Customer credit')).toHaveTextContent('25.00');
    expect(await screen.findByText('Open invoices')).toBeInTheDocument();
    expect((await screen.findAllByText('RV-2026-0001')).length).toBe(2);
    expect(await screen.findByText(/Closing balance/)).toBeInTheDocument();
    expect(screen.getAllByText('3,850.00').length).toBeGreaterThan(1);
    await userEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
  });
});

describe('aging', () => {
  it('shows the buckets per customer and per project', async () => {
    handler = (url) =>
      url.startsWith('/receivables/aging')
        ? {
            body: {
              asOf: '2026-11-18',
              groupBy: url.includes('project') ? 'project' : 'customer',
              labels: ['current', '0-30', '31-60', '61-90', '90+'],
              rows: [
                {
                  key: 'p1',
                  label: 'Synthetic Client',
                  buckets: ['10.00', '20.00', '0.00', '0.00', '5.00'],
                  total: '35.00',
                },
              ],
              totals: ['10.00', '20.00', '0.00', '0.00', '5.00'],
              total: '35.00',
            },
          }
        : undefined;
    open('/receivables/aging');
    expect(await screen.findByText('Synthetic Client')).toBeInTheDocument();
    expect(screen.getByText('Not yet due')).toBeInTheDocument();
    expect(screen.getByText('90+')).toBeInTheDocument();
    expect(screen.getByText('35.00', { selector: 'strong' })).toBeInTheDocument();
    await userEvent.click(screen.getByText('By project'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('groupBy=project'))).toBe(true));
  });
});

describe('follow-ups', () => {
  it('lists open follow-ups, adds one and marks one done', async () => {
    const followup = {
      id: 'f1',
      partyId: 'p1',
      invoiceId: null,
      pdcId: null,
      dueDate: '2026-11-20',
      note: 'Call the client',
      status: 'open',
      version: 1,
    };
    handler = (url, init) => {
      if (!url.startsWith('/receivables/followups')) return undefined;
      return { body: (init.method ?? 'GET') === 'GET' ? [followup] : followup };
    };
    open('/receivables/followups');
    expect(await screen.findByText('Call the client')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add follow-up' });
    expect(add).toBeDisabled();
    await choose('Customer', 'Synthetic Client');
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Visit the site office');
    await userEvent.click(add);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      partyId: 'p1',
      note: 'Visit the site office',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/receivables/followups/f1',
      body: { status: 'done', version: 1 },
    });
  });

  it('hides the form without the permission to record receipts', async () => {
    permissions = [receivablesPermissions.ledgerRead];
    handler = (url) => (url.startsWith('/receivables/followups') ? { body: [] } : undefined);
    open('/receivables/followups');
    expect(await screen.findByText('No open follow-ups.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add follow-up' })).not.toBeInTheDocument();
  });
});
