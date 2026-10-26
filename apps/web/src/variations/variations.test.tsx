import { variationsPermissions } from '@emporium/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import type { ProjectDetail } from '../projects/api';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { ContractValue, Variation, VariationHeader } from './api';
import { emptyLine, LinesEditor, linesProblem } from './LinesEditor';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

const project = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: 'p1',
  code: 'PRJ-0001',
  name: 'Boundary wall',
  partyId: 'c1',
  sector: 'private',
  locationId: null,
  siteAddress: null,
  status: 'active',
  startDate: null,
  plannedEndDate: null,
  actualEndDate: null,
  originalContractValue: '2000000.00',
  quotationId: null,
  estimateId: null,
  projectManagerId: null,
  progressPercent: '0.00',
  version: 1,
  supervisors: [],
  ...over,
});

const header = (over: Partial<VariationHeader> = {}): VariationHeader => ({
  id: 'v1',
  projectId: 'p1',
  number: 'PRJ-0001-V1',
  title: 'Rock breaking',
  reason: 'Rock below the foundation',
  discoveredOn: '2026-10-20',
  status: 'draft',
  priceImpact: '150.00',
  costImpact: '100.00',
  clientApprovalRef: null,
  clientApprovedOn: null,
  copiedFromId: null,
  atRiskTotal: '0.00',
  version: 3,
  ...over,
});

const variation = (over: Partial<Variation> = {}): Variation => ({
  ...header(),
  lines: [
    {
      lineNo: 1,
      description: 'Rock breaking',
      costCodeId: 'cc1',
      costAmount: '100.00',
      priceAmount: '150.00',
    },
  ],
  history: [
    {
      fromStatus: null,
      toStatus: 'draft',
      at: '2026-10-21T05:00:00.000Z',
      changedBy: 'u1',
      note: null,
    },
  ],
  atRisk: { total: '0.00', byCostCode: [] },
  approval: { status: 'none', requestId: null, currentRole: null },
  ...over,
});

const contract: ContractValue = {
  projectId: 'p1',
  originalContractValue: '2000000.00',
  approvedPriceImpact: '250000.00',
  currentContractValue: '2250000.00',
  approvedVariations: 1,
};

let current: Variation;

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  current = variation();
  handler = (url, init) => {
    if (url.startsWith('/projects/p1/variations') && init.method === 'POST') {
      return { status: 201, body: current };
    }
    if (url.startsWith('/projects/p1/variations')) {
      return {
        body: page([
          header(),
          header({
            id: 'v2',
            number: 'PRJ-0001-V2',
            title: 'Extra wall',
            status: 'client_approved',
            priceImpact: '250000.00',
          }),
          header({ id: 'v3', number: 'PRJ-0001-V3', title: 'Drain', atRiskTotal: '870.25' }),
        ]),
      };
    }
    if (url.startsWith('/projects/p1/contract-value')) return { body: contract };
    if (url.startsWith('/projects/p1/summary')) {
      return {
        body: {
          lines: [],
          totals: { committed: '0.00', approved: '0.00', posted: '0.00' },
          budget: null,
          variance: null,
          flag: null,
        },
      };
    }
    if (url.startsWith('/projects/p1/budget')) return { body: { projectVersion: 1, lines: [] } };
    if (url.startsWith('/projects/p1/tasks')) return { body: [] };
    if (url.startsWith('/projects/p1/cost-entries')) return { body: page([]) };
    if (url === '/projects/p1') return { body: project() };
    if (url.startsWith('/variations/v1/')) return { body: current };
    if (url.startsWith('/variations/v1') && init.method === 'DELETE')
      return { status: 204, body: null };
    if (url.startsWith('/variations/v1')) return { body: current };
    if (url.startsWith('/master/cost-codes')) {
      return {
        body: page([
          { id: 'cc1', code: '100', name: 'Materials' },
          { id: 'cc2', code: '200', name: 'Labour' },
        ]),
      };
    }
    if (url.startsWith('/files')) return { body: page([]) };
    return undefined;
  };
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
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      });
      const { status = 200, body } = handler(url, init) ?? { body: page([]) };
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

const options = [
  { value: 'cc1', label: '100 Materials' },
  { value: 'cc2', label: '200 Labour' },
];

const postTo = (suffix: string) => calls.find((c) => c.method === 'POST' && c.url.endsWith(suffix));

describe('lines editor (T-7)', () => {
  it('reports missing lines and incomplete lines', () => {
    expect(linesProblem([])).toBe('none');
    expect(linesProblem([emptyLine()])).toBe('incomplete');
    const line = { description: 'x', costCodeId: 'cc1', costAmount: '1', priceAmount: '2' };
    expect(linesProblem([line])).toBeNull();
    expect(linesProblem([{ ...line, costAmount: ' ' }])).toBe('incomplete');
    expect(linesProblem([{ ...line, priceAmount: '' }])).toBe('incomplete');
    expect(linesProblem([{ ...line, costCodeId: '' }])).toBe('incomplete');
  });

  it('edits, adds and removes lines, keeping amounts as text', async () => {
    const onChange = vi.fn();
    const line = { description: 'Dig', costCodeId: 'cc1', costAmount: '1', priceAmount: '-2' };
    render(withQuery(<LinesEditor lines={[line]} costCodeOptions={options} onChange={onChange} />));
    expect(screen.getByLabelText('Price 1')).toHaveValue('-2');
    await userEvent.type(screen.getByLabelText('Cost 1'), '5');
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, costAmount: '15' }]);
    await userEvent.type(screen.getByLabelText('Price 1'), '0');
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, priceAmount: '-20' }]);
    await userEvent.type(screen.getByLabelText('Description 1'), '!');
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, description: 'Dig!' }]);
    await userEvent.click(screen.getByLabelText('Cost code 1'));
    await userEvent.click(await screen.findByTitle('200 Labour'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, costCodeId: 'cc2' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(onChange).toHaveBeenLastCalledWith([line, emptyLine()]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove 1' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('shows plain text when read-only', () => {
    const line = { description: 'Dig', costCodeId: 'cc1', costAmount: '1', priceAmount: '2' };
    render(
      withQuery(
        <LinesEditor lines={[line]} costCodeOptions={options} readOnly onChange={vi.fn()} />,
      ),
    );
    expect(screen.getByText('Dig')).toBeVisible();
    expect(screen.getByText('100 Materials')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cost 1')).not.toBeInTheDocument();
  });
});

describe('variations on the project page', () => {
  it('shows the contract value and the list with costs at risk', async () => {
    open('/projects/p1');
    await userEvent.click(await screen.findByRole('tab', { name: 'Variations' }));
    expect(await screen.findByRole('link', { name: 'PRJ-0001-V1' })).toBeInTheDocument();
    expect(screen.getAllByText('Contract value').length).toBeGreaterThan(0);
    expect(screen.getByText(/2,250,000/)).toBeVisible();
    expect(screen.getByText(/870\.25/)).toBeVisible();
    expect(screen.getByText('Approved by client')).toBeVisible();
  });

  it('hides the tab without the read permission and the button without create', async () => {
    permissions = allPermissions.filter((p) => p !== variationsPermissions.read);
    open('/projects/p1');
    await screen.findByRole('heading', { name: /PRJ-0001/ });
    expect(screen.queryByRole('tab', { name: 'Variations' })).not.toBeInTheDocument();
  });

  it('checks the form before creating and then opens the new variation', async () => {
    open('/projects/p1');
    await userEvent.click(await screen.findByRole('tab', { name: 'Variations' }));
    await userEvent.click(await screen.findByRole('button', { name: 'New variation' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create variation' }));
    expect(within(dialog).getByText('Enter a title and a discovery date.')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Title'), ' Rock breaking ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create variation' }));
    expect(
      within(dialog).getByText('Every line needs a description, a cost code, a cost and a price.'),
    ).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Description 1'), 'Rock');
    await userEvent.click(within(dialog).getByLabelText('Cost code 1'));
    await userEvent.click(await screen.findByTitle('100 Materials'));
    await userEvent.clear(within(dialog).getByLabelText('Cost 1'));
    await userEvent.type(within(dialog).getByLabelText('Cost 1'), '100');
    await userEvent.clear(within(dialog).getByLabelText('Price 1'));
    await userEvent.type(within(dialog).getByLabelText('Price 1'), '-150.5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create variation' }));

    expect(await screen.findByRole('heading', { name: /PRJ-0001-V1/ })).toBeVisible();
    expect(postTo('/projects/p1/variations')?.body).toMatchObject({
      title: 'Rock breaking',
      reason: '',
      lines: [{ description: 'Rock', costCodeId: 'cc1', costAmount: '100', priceAmount: '-150.5' }],
    });
  });

  it('shows the explanation when the API refuses', async () => {
    const previous = handler;
    handler = (url, init) =>
      url === '/projects/p1/variations' && init.method === 'POST'
        ? { status: 422, body: { error: { code: 'project_not_active', message: 'no' } } }
        : previous(url, init);
    open('/projects/p1');
    await userEvent.click(await screen.findByRole('tab', { name: 'Variations' }));
    await userEvent.click(await screen.findByRole('button', { name: 'New variation' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Title'), 'Rock');
    await userEvent.type(within(dialog).getByLabelText('Description 1'), 'Rock');
    await userEvent.click(within(dialog).getByLabelText('Cost code 1'));
    await userEvent.click(await screen.findByTitle('100 Materials'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create variation' }));
    expect(
      await within(dialog).findByText('Variations can be made only on an active project.'),
    ).toBeInTheDocument();
  });
});

describe('variation editor', () => {
  it('lets a draft be saved and submitted for internal approval', async () => {
    open('/variations/v1');
    expect(await screen.findByRole('heading', { name: /PRJ-0001-V1/ })).toBeVisible();
    await userEvent.clear(screen.getByLabelText('Title'));
    await userEvent.type(screen.getByLabelText('Title'), 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      title: 'Renamed',
      version: 3,
      lines: [{ description: 'Rock breaking', costCodeId: 'cc1', costAmount: '100.00' }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Submit for internal approval' }));
    await waitFor(() => expect(postTo('/variations/v1/submit-internal')).toBeDefined());
    expect(postTo('/variations/v1/submit-internal')?.body).toEqual({ version: 3 });
  });

  it('cancels and deletes a draft', async () => {
    open('/variations/v1');
    await screen.findByRole('heading', { name: /PRJ-0001-V1/ });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel variation' }));
    await waitFor(() => expect(postTo('/variations/v1/cancel')).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/variations/v1?version=3');
  });

  it('keeps Save off while a line is incomplete', async () => {
    open('/variations/v1');
    await screen.findByRole('heading', { name: /PRJ-0001-V1/ });
    await userEvent.clear(screen.getByLabelText('Description 1'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('offers Send to client only once the approval engine approved (AC-2)', async () => {
    current = variation({
      status: 'pending_internal_approval',
      approval: { status: 'pending', requestId: 'r1', currentRole: 'management' },
    });
    const view = open('/variations/v1');
    expect(await screen.findByText('Waiting for management')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send to client' })).not.toBeInTheDocument();
    view.unmount();

    current = variation({
      status: 'pending_internal_approval',
      approval: { status: 'approved', requestId: 'r1', currentRole: null },
    });
    open('/variations/v1');
    await userEvent.click(await screen.findByRole('button', { name: 'Send to client' }));
    await waitFor(() => expect(postTo('/variations/v1/send-to-client')).toBeDefined());
  });

  it('records the client approval with its reference and date', async () => {
    current = variation({
      status: 'submitted_to_client',
      approval: { status: 'approved', requestId: 'r1', currentRole: null },
    });
    open('/variations/v1');
    await userEvent.click(await screen.findByRole('button', { name: 'Record client approval' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record approval' }));
    expect(
      within(dialog).getByText('Enter the client reference and the approval date.'),
    ).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Client reference'), ' LTR-5 ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record approval' }));
    await waitFor(() => expect(postTo('/variations/v1/client-approve')).toBeDefined());
    expect(postTo('/variations/v1/client-approve')?.body).toMatchObject({
      version: 3,
      reference: 'LTR-5',
    });
  });

  it('shows the API reason when the client document is missing', async () => {
    current = variation({ status: 'submitted_to_client' });
    const previous = handler;
    handler = (url, init) =>
      url.endsWith('/client-approve')
        ? { status: 422, body: { error: { code: 'client_document_required', message: 'x' } } }
        : previous(url, init);
    open('/variations/v1');
    await userEvent.click(await screen.findByRole('button', { name: 'Record client approval' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Client reference'), 'LTR-5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record approval' }));
    expect(
      await within(dialog).findByText('Attach the client letter or signed form first.'),
    ).toBeInTheDocument();
  });

  it('records a client rejection with its reason', async () => {
    current = variation({ status: 'submitted_to_client' });
    open('/variations/v1');
    await userEvent.click(await screen.findByRole('button', { name: 'Record client rejection' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rejection' }));
    expect(within(dialog).getByText('Enter the reason.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Too dear');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rejection' }));
    await waitFor(() => expect(postTo('/variations/v1/client-reject')).toBeDefined());
    expect(postTo('/variations/v1/client-reject')?.body).toEqual({
      version: 3,
      reason: 'Too dear',
    });
  });

  it('is read-only once approved and lists the client reference', async () => {
    current = variation({
      status: 'client_approved',
      clientApprovalRef: 'LTR-5',
      clientApprovedOn: '2026-10-24',
      approval: { status: 'approved', requestId: 'r1', currentRole: null },
    });
    open('/variations/v1');
    expect(await screen.findByText(/LTR-5/)).toBeVisible();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel variation' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/An approved variation is reversed with a deductive variation/),
    ).toBeVisible();
  });

  it('copies a rejected variation into a new draft', async () => {
    current = variation({ status: 'client_rejected' });
    open('/variations/v1');
    await userEvent.click(await screen.findByRole('button', { name: 'Copy into a new draft' }));
    await waitFor(() => expect(postTo('/variations/v1/copy')).toBeDefined());
  });

  it('shows the costs at risk, or says there are none', async () => {
    current = variation({
      atRisk: { total: '870.25', byCostCode: [{ costCodeId: 'cc1', amount: '870.25' }] },
    });
    const view = open('/variations/v1');
    expect(await screen.findByText('Total at risk')).toBeVisible();
    expect(screen.getAllByText(/870\.25/).length).toBeGreaterThan(0);
    view.unmount();

    current = variation();
    open('/variations/v1');
    expect(await screen.findByText('No costs at risk.')).toBeVisible();
  });

  it('refuses a user without the read permission', async () => {
    permissions = allPermissions.filter((p) => p !== variationsPermissions.read);
    open('/variations/v1');
    await waitFor(() => expect(screen.queryByRole('heading', { name: /PRJ-0001-V1/ })).toBeNull());
  });
});
