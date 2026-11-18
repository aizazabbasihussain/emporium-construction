import { billingPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { ProjectBilling } from './ProjectBilling';
import { isPositiveAmount, optionalAmount, scheduleProblem } from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const stage = (n: number, amount: string, status = 'planned', source = 'quotation') => ({
  id: `s${n}`,
  stageNo: n,
  name: `Stage ${n} name`,
  basisPercent: null,
  amount,
  source,
  sourceId: null,
  status,
});

const schedule = {
  projectId: 'p1',
  originalContractValue: '1000000.00',
  contractValue: '1000000.00',
  scheduleTotal: '1000000.00',
  matchesContract: true,
  pendingEditId: null,
  stages: [
    stage(1, '300000.00', 'invoiced'),
    stage(2, '400000.00'),
    stage(3, '300000.00', 'planned', 'variation'),
  ],
};

const summary = {
  projectId: 'p1',
  originalContractValue: '1000000.00',
  contractValue: '1000000.00',
  netBilled: '300000.00',
  remainingToBill: '700000.00',
  unappliedAdvance: '50000.00',
  plannedStages: '700000.00',
  invoices: 1,
  advances: [
    {
      id: 'a1',
      projectId: 'p1',
      invoiceId: 'inv-adv',
      amount: '100000.00',
      receivedOn: '2026-11-19',
      applied: '50000.00',
      status: 'received',
      version: 3,
    },
    {
      id: 'a2',
      projectId: 'p1',
      invoiceId: null,
      amount: '1000.00',
      receivedOn: null,
      applied: '0.00',
      status: 'requested',
      version: 1,
    },
  ],
};

const header = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  number: null,
  seriesCode: null,
  authorityCode: null,
  sourceType: 'project_stage',
  projectId: 'p1',
  partyId: 'c1',
  invoiceDate: '2026-11-18',
  dueDate: '2026-12-18',
  status: 'draft',
  baseAmount: '400000.00',
  advanceRecovery: '0.00',
  taxableBase: '400000.00',
  taxTotal: '0.00',
  grossTotal: '400000.00',
  withholdingExpected: '0.00',
  registrationNumber: null,
  taxOnAdvanceAtReceipt: true,
  paymentDays: null,
  notes: null,
  issuedAt: null,
  version: 1,
  ...over,
});

const invoice = (over: Record<string, unknown> = {}) => ({
  ...header(over),
  lines: [
    {
      lineNo: 1,
      scheduleId: 's2',
      description: 'Stage 2: Structure',
      amount: '400000.00',
      supplyKind: 'services',
      nature: null,
    },
  ],
  approval: { status: 'none', requestId: null, currentRole: null },
  creditedBase: '0.00',
  taxSnapshot: null,
});

const preview = {
  baseAmount: '400000.00',
  advanceRecovery: '40000.00',
  taxableBase: '360000.00',
  taxTotal: '36000.00',
  grossTotal: '396000.00',
  withholdingExpected: '8000.00',
  taxOnAdvanceAtReceipt: false,
  authorityCode: 'FBR',
  registrationNumber: 'TEST-FBR-1',
  dueDate: '2026-12-18',
};

const credit = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  number: null,
  invoiceId: 'i1',
  reason: 'Wrong stage',
  baseAmount: '100.00',
  advanceRestored: '0.00',
  taxTotal: '10.00',
  grossTotal: '110.00',
  issuedOn: null,
  status: 'draft',
  approval: { status: 'none', requestId: null, currentRole: null },
  version: 1,
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = () => undefined;
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
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
      const { status = 200, body } = handler(url, init) ?? { body: {} };
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
        blob: () => Promise.resolve(new Blob(['%PDF'])),
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const project = (extra?: (url: string, init: RequestInit) => Reply | undefined) => {
  handler = (url, init) =>
    extra?.(url, init) ??
    (url === '/billing/schedule/p1'
      ? { body: schedule }
      : url === '/billing/projects/p1/summary'
        ? { body: summary }
        : url.startsWith('/billing/invoices?')
          ? {
              body: {
                items: [
                  header({
                    id: 'i9',
                    number: 'INV-2026-0001',
                    status: 'issued',
                    grossTotal: '330000.00',
                  }),
                ],
                total: 1,
                limit: 200,
                offset: 0,
              },
            }
          : undefined);
  return render(
    <AppProviders auth={fakeAuth()}>
      <MemoryRouter>
        <ProjectBilling projectId="p1" />
      </MemoryRouter>
    </AppProviders>,
  );
};

const open = (path: string) =>
  render(
    <AppProviders auth={fakeAuth()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

describe('form checks', () => {
  it('finds the first problem of a stage list', () => {
    const ok = { stageNo: 2, name: 'A', amount: '10.50' };
    expect(scheduleProblem([ok], [1])).toBeNull();
    expect(scheduleProblem([{ ...ok, stageNo: 0 }], [])).toBe('stageNo');
    expect(scheduleProblem([{ ...ok, stageNo: 1.5 }], [])).toBe('stageNo');
    expect(scheduleProblem([{ ...ok, name: ' ' }], [])).toBe('name');
    expect(scheduleProblem([{ ...ok, amount: 'x' }], [])).toBe('amount');
    expect(scheduleProblem([{ ...ok, amount: '0.00' }], [])).toBe('amount');
    expect(scheduleProblem([{ ...ok, amount: '-5' }], [])).toBeNull();
    expect(scheduleProblem([ok], [2])).toBe('duplicate');
    expect(scheduleProblem([ok, ok], [])).toBe('duplicate');
  });

  it('checks amounts', () => {
    expect(isPositiveAmount('10')).toBe(true);
    expect(isPositiveAmount(' 10.55 ')).toBe(true);
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('-1')).toBe(false);
    expect(isPositiveAmount('1.234')).toBe(false);
    expect(optionalAmount('  ')).toBeUndefined();
    expect(optionalAmount(' 5 ')).toBe('5');
  });
});

describe('project billing', () => {
  it('shows the summary, the schedule, the advances and the invoices of the project', async () => {
    project();
    expect(await screen.findByText('Billing summary')).toBeInTheDocument();
    expect(await screen.findByText('Stage 2 name')).toBeInTheDocument();
    expect(screen.getByText('Variation')).toBeInTheDocument();
    expect(screen.getByText('Invoiced')).toBeInTheDocument();
    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(screen.getByText('Requested')).toBeInTheDocument();
    expect(await screen.findByText('INV-2026-0001')).toBeInTheDocument();
    expect(screen.queryByText(/No invoice can be issued/)).not.toBeInTheDocument();
  });

  it('warns when the stages do not add up and when a change waits for approval', async () => {
    project((url) =>
      url === '/billing/schedule/p1'
        ? {
            body: {
              ...schedule,
              matchesContract: false,
              scheduleTotal: '900000.00',
              pendingEditId: 'e1',
            },
          }
        : undefined,
    );
    expect(
      await screen.findByText(/add up to .*900,000.00.* contract value is .*1,000,000.00/),
    ).toBeInTheDocument();
    expect(screen.getByText(/waiting for approval/)).toBeInTheDocument();
  });

  it('says the schedule and the lists are empty', async () => {
    project((url) =>
      url === '/billing/schedule/p1'
        ? { body: { ...schedule, stages: [] } }
        : url === '/billing/projects/p1/summary'
          ? { body: { ...summary, advances: [] } }
          : url.startsWith('/billing/invoices?')
            ? { body: { items: [], total: 0, limit: 200, offset: 0 } }
            : undefined,
    );
    expect(await screen.findByText(/schedule is empty/)).toBeInTheDocument();
    expect(screen.getByText('No advance has been requested.')).toBeInTheDocument();
    expect(screen.getByText('No invoices yet.')).toBeInTheDocument();
  });

  it('edits the planned stages and sends them for approval', async () => {
    project((url, init) =>
      url === '/billing/schedule/p1' && init.method === 'PUT'
        ? { body: { ...schedule, pendingEditId: 'e1' } }
        : undefined,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Edit schedule' }));
    // Only the planned stages are editable.
    expect(screen.getAllByRole('textbox', { name: 'Name' })).toHaveLength(2);
    const amounts = screen.getAllByRole('textbox', { name: 'Amount' });
    await userEvent.clear(amounts[0] as HTMLElement);
    await userEvent.type(amounts[0] as HTMLElement, '450000');
    await userEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    const names = screen.getAllByRole('textbox', { name: 'Name' });
    expect(names).toHaveLength(3);
    // The new stage takes the next free number, above the invoiced one.
    expect(
      screen.getAllByRole('textbox', { name: 'Stage' }).map((i) => (i as HTMLInputElement).value),
    ).toEqual(['2', '3', '4']);
    await userEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Every stage needs a name.')).toBeInTheDocument();
    await userEvent.type(
      screen.getAllByRole('textbox', { name: 'Name' })[2] as HTMLElement,
      'Extra',
    );
    await userEvent.type(
      screen.getAllByRole('textbox', { name: 'Amount' })[2] as HTMLElement,
      '10',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      stages: [
        { id: 's2', stageNo: 2, name: 'Stage 2 name', amount: '450000' },
        { id: 's3', stageNo: 3, name: 'Stage 3 name', amount: '300000.00' },
        { stageNo: 4, name: 'Extra', amount: '10' },
      ],
    });
    expect(await screen.findByRole('button', { name: 'Edit schedule' })).toBeInTheDocument();
  });

  it('removes a stage and lets the user leave the editor', async () => {
    project();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit schedule' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement);
    expect(screen.getAllByRole('textbox', { name: 'Name' })).toHaveLength(1);
    await userEvent.type(screen.getByRole('textbox', { name: 'Stage' }), '{backspace}{backspace}0');
    await userEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText(/whole number above zero/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Edit schedule' })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('creates a draft invoice from the planned stages', async () => {
    project((url, init) =>
      url === '/billing/invoices' && init.method === 'POST'
        ? { status: 201, body: invoice() }
        : undefined,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'New invoice' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    expect(
      await within(dialog).findByText('Choose at least one stage and a date.'),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /2\. Stage 2 name/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      projectId: 'p1',
      scheduleIds: ['s2'],
    });
  });

  it('requests an advance and opens its invoice', async () => {
    project((url, init) =>
      url === '/billing/advances' && init.method === 'POST'
        ? {
            status: 201,
            body: { advance: summary.advances[1], invoice: invoice({ sourceType: 'advance' }) },
          }
        : undefined,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Request advance' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create advance invoice' }));
    expect(
      await within(dialog).findByText('Enter an amount above zero and a date.'),
    ).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Amount' }), '250000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create advance invoice' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      projectId: 'p1',
      amount: '250000',
    });
  });

  it('hides the actions from a reader who may not change anything', async () => {
    permissions = [billingPermissions.scheduleRead, billingPermissions.invoiceRead];
    project();
    expect(await screen.findByText('Stage 2 name')).toBeInTheDocument();
    for (const name of ['Edit schedule', 'Request advance', 'New invoice']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });
});

describe('invoices page', () => {
  it('lists the invoices and filters them by status', async () => {
    handler = (url) =>
      url.startsWith('/billing/invoices?')
        ? {
            body: {
              items: [
                header({
                  id: 'i1',
                  number: 'INV-2026-0001',
                  status: 'issued',
                  grossTotal: '330000.00',
                }),
                header({ id: 'i2', status: 'draft' }),
              ],
              total: 2,
              limit: 200,
              offset: 0,
            },
          }
        : undefined;
    open('/billing/invoices');
    expect(await screen.findByText('INV-2026-0001')).toBeInTheDocument();
    expect(screen.getByText('Draft', { selector: 'a' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    await userEvent.click(await screen.findByTitle('Issued'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=issued'))).toBe(true));
  });
});

describe('invoice page', () => {
  const draftHandler = (over?: Record<string, unknown>) => {
    handler = (url, init) => {
      if (url === '/billing/invoices/i1' && init.method === 'GET') return { body: invoice(over) };
      if (url === '/billing/invoices/i1/preview') return { body: preview };
      if (url === '/billing/invoices/i1/credit-notes') return { body: [] };
      return undefined;
    };
  };

  it('shows the tax preview of a draft and sends it for approval', async () => {
    draftHandler();
    open('/billing/invoices/i1');
    expect(await screen.findByText('Tax preview')).toBeInTheDocument();
    expect(await screen.findByText('396,000.00')).toBeInTheDocument();
    expect(screen.getByText('36,000.00')).toBeInTheDocument();
    expect(screen.getByText('taken off the taxable base')).toBeInTheDocument();
    expect(screen.getByText(/FBR\s+TEST-FBR-1/)).toBeInTheDocument();
    expect(screen.getByText('Stage 2: Structure')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/billing/invoices/i1/submit')).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/submit'))?.body).toEqual({ version: 1 });
  });

  it('shows why the tax cannot be worked out', async () => {
    handler = (url, init) => {
      if (url === '/billing/invoices/i1' && init.method === 'GET') return { body: invoice() };
      if (url === '/billing/invoices/i1/preview') {
        return {
          status: 422,
          body: {
            error: {
              code: 'tax_rule_missing',
              message: 'No tax rule applies to services on 2026-11-18',
            },
          },
        };
      }
      return undefined;
    };
    open('/billing/invoices/i1');
    expect(
      await screen.findByText('No tax rule applies to services on 2026-11-18'),
    ).toBeInTheDocument();
  });

  it('cancels a draft', async () => {
    draftHandler();
    open('/billing/invoices/i1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel invoice' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/billing/invoices/i1?version=1');
  });

  it('shows the waiting note and offers no issue before approval; an approved invoice can be issued', async () => {
    handler = (url, init) =>
      url === '/billing/invoices/i1' && init.method === 'GET'
        ? {
            body: {
              ...invoice({ status: 'pending_approval' }),
              approval: { status: 'pending', requestId: 'r', currentRole: 'management' },
            },
          }
        : undefined;
    const first = open('/billing/invoices/i1');
    expect(await screen.findByText(/waiting for the owner/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).not.toBeInTheDocument();
    first.unmount();
    handler = (url, init) =>
      url === '/billing/invoices/i1' && init.method === 'GET'
        ? { body: invoice({ status: 'approved', version: 4 }) }
        : undefined;
    open('/billing/invoices/i1');
    await userEvent.click(await screen.findByRole('button', { name: 'Issue invoice' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/billing/invoices/i1/issue')).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/issue'))?.body).toEqual({ version: 4 });
  });

  const issuedHandler = (credits: unknown[]) => {
    handler = (url, init) => {
      if (url === '/billing/invoices/i1' && init.method === 'GET') {
        return {
          body: invoice({
            status: 'issued',
            number: 'INV-2026-0007',
            authorityCode: 'FBR',
            registrationNumber: 'TEST-FBR-1',
            taxTotal: '40000.00',
            taxableBase: '400000.00',
            grossTotal: '440000.00',
          }),
        };
      }
      if (url === '/billing/invoices/i1/credit-notes' && init.method === 'GET')
        return { body: credits };
      if (url === '/billing/invoices/i1/credit-notes' && init.method === 'POST')
        return { status: 201, body: credit() };
      if (url === '/billing/invoices/i1/cancel-by-credit-note')
        return { status: 201, body: credit() };
      return undefined;
    };
  };

  it('an issued invoice can be credited for an amount, with a reason', async () => {
    issuedHandler([]);
    open('/billing/invoices/i1');
    expect(await screen.findByRole('heading', { name: /INV-2026-0007/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel invoice' })).not.toBeInTheDocument();
    expect(await screen.findByText('No credit notes.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Credit note' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create credit note' }));
    expect(await within(dialog).findByText(/Give a reason/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Discount');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Amount to credit' }), '-5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create credit note' }));
    expect(await within(dialog).findByText(/Give a reason/)).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Amount to credit' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Amount to credit' }), '100');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create credit note' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      reason: 'Discount',
      baseAmount: '100',
    });
  });

  it('an issued invoice is cancelled only by a credit note for all of it', async () => {
    issuedHandler([]);
    open('/billing/invoices/i1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel by credit note' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).queryByRole('textbox', { name: 'Amount to credit' }),
    ).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Billed twice');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Create credit note for all of it' }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/cancel-by-credit-note'))).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/cancel-by-credit-note'))?.body).toEqual({
      reason: 'Billed twice',
    });
  });

  it('a credit note is sent for approval, then issued once approved', async () => {
    issuedHandler([
      credit({ id: 'c1', approval: { status: 'none', requestId: null, currentRole: null } }),
      credit({
        id: 'c2',
        version: 4,
        approval: { status: 'approved', requestId: 'r', currentRole: null },
      }),
      credit({
        id: 'c3',
        approval: { status: 'pending', requestId: 'r', currentRole: 'management' },
      }),
      credit({
        id: 'c4',
        status: 'issued',
        number: 'CN-2026-0001',
        approval: { status: 'approved', requestId: 'r', currentRole: null },
      }),
    ]);
    open('/billing/invoices/i1');
    expect(await screen.findByText('CN-2026-0001')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Send for approval' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/billing/credit-notes/c1/submit')).toBe(true),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/billing/credit-notes/c2/issue')).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/c2/issue'))?.body).toEqual({ version: 4 });
  });

  it('a reader cannot change or credit an invoice', async () => {
    permissions = [billingPermissions.invoiceRead];
    issuedHandler([credit()]);
    open('/billing/invoices/i1');
    expect(await screen.findByText('Wrong stage')).toBeInTheDocument();
    for (const name of ['Credit note', 'Cancel by credit note', 'Send for approval', 'Issue']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Print PDF' })).toBeInTheDocument();
  });

  it('downloads the PDF through an authenticated request', async () => {
    const createObjectURL = vi.fn(() => 'blob:invoice');
    vi.stubGlobal('URL', { ...URL, createObjectURL });
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null);
    draftHandler();
    open('/billing/invoices/i1');
    await userEvent.click(await screen.findByRole('button', { name: 'Print PDF' }));
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith('blob:invoice', '_blank'));
    expect(calls.some((c) => c.url === '/billing/invoices/i1/pdf')).toBe(true);
  });
});
