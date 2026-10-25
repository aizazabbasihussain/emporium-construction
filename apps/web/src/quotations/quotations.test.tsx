import { quotationsPermissions } from '@emporium/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { MarginPanelData, PrintModel, Quotation, Stage } from './api';
import { StageEditor, stageProblem } from './StageEditor';

type Reply = { status?: number; body: unknown };
type Handler = (url: string, init: RequestInit) => Reply | undefined;
let handler: Handler;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

const margin: MarginPanelData = {
  totalCost: '1000.00',
  marginAmount: '200.00',
  marginPercent: '16.6667',
  floorPercent: '0.0000',
  belowFloor: false,
};

const stages: Stage[] = [
  {
    stageNo: 1,
    name: 'Advance',
    basis: 'percent',
    percent: '30.0000',
    amount: '360.00',
    conditionText: 'On signing',
  },
  {
    stageNo: 2,
    name: 'Completion',
    basis: 'percent',
    percent: '70.0000',
    amount: '840.00',
    conditionText: null,
  },
];

const quotation = (over: Partial<Quotation> = {}): Quotation => ({
  id: 'q1',
  number: 'QUO-2026-0001',
  revision: 1,
  displayNumber: 'QUO-2026-0001',
  parentId: null,
  leadId: null,
  estimateId: 'e1',
  partyId: 'p1',
  title: 'Boundary wall',
  sector: 'private',
  locationId: null,
  validityDays: 30,
  price: '1200.00',
  status: 'draft',
  issuedAt: null,
  acceptedAt: null,
  acceptedByName: null,
  expiresOn: null,
  version: 3,
  scopeText: 'Build a wall',
  inclusions: 'Materials',
  exclusions: 'Painting',
  terms: 'Net 7 days',
  stages,
  history: [
    {
      fromStatus: null,
      toStatus: 'draft',
      at: '2026-10-25T10:00:00Z',
      changedBy: null,
      note: null,
    },
  ],
  margin: null,
  approval: { status: 'none', requestId: null, currentRole: null },
  ...over,
});

const printModel: PrintModel = {
  company: { name: 'Synthetic Construction', address: 'Islamabad', phone: null, email: null },
  registrations: [{ authority: 'FBR', registrationType: 'ntn', number: 'SYN-1' }],
  client: { name: 'A Client', address: null, city: 'Lahore' },
  quotation: {
    number: 'QUO-2026-0001',
    revision: 1,
    title: 'Boundary wall',
    issuedOn: '2026-10-25',
    expiresOn: '2026-11-24',
    validityDays: 30,
  },
  scope: 'Build a wall',
  inclusions: '',
  exclusions: 'Painting',
  stages: [
    { stageNo: 1, name: 'Advance', percent: '30.0000', amount: '360.00', condition: 'On signing' },
  ],
  terms: 'Net 7 days',
  price: '1200.00',
};

let current: Quotation;

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  current = quotation();
  handler = (url) => {
    if (url.startsWith('/quotations/q1/print-model')) return { body: printModel };
    if (url.startsWith('/quotations/q1')) return { body: current };
    if (url.startsWith('/quotations?')) {
      return {
        body: page([
          quotation(),
          quotation({ id: 'q2', displayNumber: 'QUO-2026-0002/2', status: 'issued' }),
        ]),
      };
    }
    if (url.startsWith('/estimation/estimates')) {
      return {
        body: page([{ id: 'e1', number: 'EST-0001', revision: 1, title: 'Wall estimate' }]),
      };
    }
    if (url.startsWith('/files')) return { body: page([]) };
    return undefined;
  };
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
      const { status = 200, body } = handler(url, init) ?? { body: page([]) };
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
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

describe('stage editor (spec T-8)', () => {
  const blank: Stage = { name: '', basis: 'percent', percent: '', amount: '', conditionText: null };

  it('reports the first thing missing without doing any arithmetic', () => {
    expect(stageProblem([])).toBeNull();
    expect(stageProblem([{ ...blank, percent: '100' }])).toBe('nameRequired');
    expect(stageProblem([{ ...blank, name: 'A' }])).toBe('valueRequired');
    expect(stageProblem([{ ...blank, name: 'A', basis: 'amount', amount: '5' }])).toBeNull();
    expect(stageProblem([{ ...blank, name: 'A', basis: 'amount', percent: '5' }])).toBe(
      'valueRequired',
    );
  });

  it('edits names, percents and conditions, adds and removes stages', async () => {
    const onChange = vi.fn();
    render(withQuery(<StageEditor stages={stages} onChange={onChange} />));
    expect(screen.getByText('360.00')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Stage 1'), 'X');
    expect(onChange).toHaveBeenLastCalledWith([{ ...stages[0], name: 'AdvanceX' }, stages[1]]);
    await userEvent.type(screen.getByLabelText('Percent 2'), '5');
    expect(onChange).toHaveBeenLastCalledWith([stages[0], { ...stages[1], percent: '70.00005' }]);
    await userEvent.type(screen.getByLabelText('Condition 2'), 'c');
    expect(onChange).toHaveBeenLastCalledWith([stages[0], { ...stages[1], conditionText: 'c' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    expect(onChange).toHaveBeenLastCalledWith([
      ...stages,
      { name: '', basis: 'percent', percent: '', amount: '', conditionText: null },
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove 1' }));
    expect(onChange).toHaveBeenLastCalledWith([stages[1]]);
  });

  it('switches the whole schedule between percent and amount', async () => {
    const onChange = vi.fn();
    render(withQuery(<StageEditor stages={stages} onChange={onChange} />));
    await userEvent.click(screen.getByLabelText('Basis'));
    await userEvent.click(await screen.findByText('Fixed amount'));
    expect(onChange).toHaveBeenLastCalledWith(
      stages.map((stage) => ({ ...stage, basis: 'amount' })),
    );
  });

  it('warns about missing values and shows an error from the API', () => {
    render(
      withQuery(
        <StageEditor
          stages={[{ ...blank, percent: '100' }]}
          onChange={vi.fn()}
          error="Stage percents must add up to exactly 100."
        />,
      ),
    );
    expect(screen.getByText('Every stage needs a name.')).toBeInTheDocument();
    expect(screen.getByText('Stage percents must add up to exactly 100.')).toBeInTheDocument();
  });

  it('is read-only when disabled', () => {
    render(withQuery(<StageEditor stages={stages} onChange={vi.fn()} disabled />));
    expect(screen.getByLabelText('Stage 1')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add stage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove 1' })).not.toBeInTheDocument();
  });
});

describe('quotations list', () => {
  it('lists quotations with their numbers and creates one from a locked estimate', async () => {
    open('/quotations');
    expect(await screen.findByText('QUO-2026-0002/2')).toBeInTheDocument();
    expect(screen.getByText('QUO-2026-0001')).toBeInTheDocument();

    handler = (url, init) => {
      if (init.method === 'POST') return { status: 201, body: quotation() };
      if (url.startsWith('/estimation/estimates')) {
        return {
          body: page([{ id: 'e1', number: 'EST-0001', revision: 1, title: 'Wall estimate' }]),
        };
      }
      return { body: quotation() };
    };
    await userEvent.click(screen.getByRole('button', { name: 'New quotation' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create quotation' }));
    expect(await screen.findByText('Choose a locked estimate.')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Locked estimate'));
    await userEvent.click(await screen.findByText('EST-0001 / 1 - Wall estimate'));
    await userEvent.click(screen.getByRole('button', { name: 'Create quotation' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: '/quotations',
        body: {
          estimateId: 'e1',
          stages: [{ name: 'Full payment', basis: 'percent', percent: '100', conditionText: null }],
        },
      }),
    );
    expect(await screen.findByText('Back to quotations')).toBeInTheDocument();
  });

  it('shows the API reason when a quotation cannot be created', async () => {
    open('/quotations');
    await screen.findByText('QUO-2026-0002/2');
    handler = (url, init) =>
      init.method === 'POST'
        ? { status: 422, body: { error: { code: 'estimate_not_locked', message: 'x' } } }
        : url.startsWith('/estimation/estimates')
          ? { body: page([{ id: 'e1', number: 'EST-0001', revision: 1, title: 'Wall estimate' }]) }
          : { body: page([]) };
    await userEvent.click(screen.getByRole('button', { name: 'New quotation' }));
    await userEvent.click(screen.getByLabelText('Locked estimate'));
    await userEvent.click(await screen.findByText('EST-0001 / 1 - Wall estimate'));
    await userEvent.click(screen.getByRole('button', { name: 'Create quotation' }));
    expect(
      await screen.findByText('A quotation can be made only from a locked estimate.'),
    ).toBeInTheDocument();
  });

  it('hides the new button without the create permission and keeps the page from other users', async () => {
    permissions = allPermissions.filter((p) => p !== quotationsPermissions.create);
    open('/quotations');
    await screen.findByText('QUO-2026-0002/2');
    expect(screen.queryByRole('button', { name: 'New quotation' })).not.toBeInTheDocument();
  });

  it('is not shown to a user without read permission', async () => {
    permissions = [];
    open('/quotations');
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});

describe('quotation editor', () => {
  it('lets a draft be edited and saved, sending the stages without amounts', async () => {
    open('/quotations/q1');
    expect(await screen.findByText('QUO-2026-0001')).toBeInTheDocument();
    expect(screen.queryByText('Cost and margin')).not.toBeInTheDocument();
    const price = screen.getByLabelText('Price (excluding tax)');
    await userEvent.clear(price);
    await userEvent.type(price, '1500');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/quotations/q1');
    expect(put?.body).toMatchObject({
      price: '1500',
      validityDays: 30,
      version: 3,
      title: 'Boundary wall',
      stages: [
        { name: 'Advance', basis: 'percent', percent: '30.0000', conditionText: 'On signing' },
        { name: 'Completion', basis: 'percent', percent: '70.0000', conditionText: null },
      ],
    });
    expect(JSON.stringify(put?.body)).not.toContain('360.00');
  });

  it('keeps Save off until every stage is filled in, and shows the API message on failure', async () => {
    open('/quotations/q1');
    await screen.findByText('QUO-2026-0001');
    await userEvent.clear(screen.getByLabelText('Percent 1'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Percent 1'), '20');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    handler = () => ({ status: 400, body: { error: { code: 'stage_percent_sum', message: 'x' } } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Stage percents must add up to exactly 100.'),
    ).toBeInTheDocument();
  });

  it('shows the margin panel only when the API sends it', async () => {
    current = quotation({ margin });
    open('/quotations/q1');
    expect(await screen.findByText('Cost and margin')).toBeInTheDocument();
    expect(screen.getByText('1,000.00')).toBeInTheDocument();
    expect(screen.getByText('16.6667%')).toBeInTheDocument();
    expect(screen.getByText('At or above the margin floor')).toBeInTheDocument();
  });

  it('flags a margin below the floor', async () => {
    current = quotation({ margin: { ...margin, belowFloor: true, floorPercent: '20.0000' } });
    open('/quotations/q1');
    expect(await screen.findByText('Below the margin floor')).toBeInTheDocument();
  });

  it('submits a draft for approval', async () => {
    open('/quotations/q1');
    await screen.findByText('QUO-2026-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/quotations/q1/submit')).toMatchObject({
        method: 'POST',
        body: { version: 3 },
      }),
    );
  });

  it('shows the approval state and issues an approved quotation', async () => {
    current = quotation({
      status: 'approved',
      approval: { status: 'approved', requestId: 'r1', currentRole: null },
    });
    open('/quotations/q1');
    expect(
      await screen.findByText(
        'This quotation can no longer be edited. Create a revision to change it.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Issue to client' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/quotations/q1/issue')).toMatchObject({
        body: { version: 3 },
      }),
    );
  });

  it('says who the approval waits for', async () => {
    current = quotation({
      status: 'pending_approval',
      approval: { status: 'pending', requestId: 'r1', currentRole: 'management' },
    });
    open('/quotations/q1');
    expect(await screen.findByText('Waiting for management')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).not.toBeInTheDocument();
  });

  it('records the acceptance of an issued quotation, asking for the name first', async () => {
    current = quotation({ status: 'issued', sector: 'government', expiresOn: '2026-11-24' });
    open('/quotations/q1');
    await screen.findByText('24/11/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Record acceptance' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/needs the signed acceptance document/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record acceptance' }));
    expect(await within(dialog).findByText('Enter who accepted.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Accepted by (client)'), 'Mr Client');
    await userEvent.type(within(dialog).getByLabelText('Note'), 'Signed copy');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record acceptance' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/quotations/q1/accept')).toMatchObject({
        body: { version: 3, acceptedByName: 'Mr Client', note: 'Signed copy' },
      }),
    );
  });

  it('shows the API reason when the acceptance is refused', async () => {
    current = quotation({ status: 'issued', expiresOn: '2026-11-24' });
    open('/quotations/q1');
    await screen.findByText('24/11/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Record acceptance' }));
    const dialog = await screen.findByRole('dialog');
    handler = () => ({
      status: 422,
      body: { error: { code: 'acceptance_document_required', message: 'x' } },
    });
    await userEvent.type(within(dialog).getByLabelText('Accepted by (client)'), 'Mr Client');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record acceptance' }));
    expect(
      await within(dialog).findByText(
        'Attach the client acceptance document before accepting a government quotation.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('records a rejection with a reason', async () => {
    current = quotation({ status: 'issued', expiresOn: '2026-11-24' });
    open('/quotations/q1');
    await screen.findByText('24/11/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Record rejection' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rejection' }));
    expect(await within(dialog).findByText('Enter the reason.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Too dear');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record rejection' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/quotations/q1/reject')).toMatchObject({
        body: { version: 3, reason: 'Too dear' },
      }),
    );
  });

  it('revises a rejected quotation and opens the revision', async () => {
    current = quotation({ status: 'rejected' });
    open('/quotations/q1');
    await screen.findByText('QUO-2026-0001');
    handler = (url, init) =>
      init.method === 'POST'
        ? {
            status: 201,
            body: quotation({ id: 'q1', displayNumber: 'QUO-2026-0001/2', revision: 2 }),
          }
        : { body: current };
    await userEvent.click(screen.getByRole('button', { name: 'Create revision' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/quotations/q1/revise')).toMatchObject({
        method: 'POST',
      }),
    );
  });

  it('hides the workflow buttons from a reader', async () => {
    permissions = [quotationsPermissions.read];
    current = quotation({ status: 'issued', expiresOn: '2026-11-24' });
    open('/quotations/q1');
    await screen.findByText('24/11/2026');
    for (const name of [
      'Record acceptance',
      'Record rejection',
      'Create revision',
      'Save',
      'Submit for approval',
    ]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Print preview' })).toBeInTheDocument();
  });

  it('shows the print preview from the print model, without cost or margin', async () => {
    current = quotation({ revision: 2, displayNumber: 'QUO-2026-0001/2', margin });
    open('/quotations/q1');
    await screen.findByText('QUO-2026-0001/2');
    expect(screen.getByText('Revision 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Print preview' }));
    const preview = await screen.findByLabelText('Print preview', { selector: 'div' });
    expect(within(preview).getByText('Synthetic Construction')).toBeInTheDocument();
    expect(within(preview).getByText('Painting')).toBeInTheDocument();
    expect(within(preview).getByText(/FBR NTN: SYN-1/)).toBeInTheDocument();
    expect(within(preview).getByText(/1,200.00/)).toBeInTheDocument();
    expect(preview.textContent).not.toMatch(/margin|cost/i);
  });

  it('says when the print preview cannot be loaded', async () => {
    open('/quotations/q1');
    await screen.findByText('QUO-2026-0001');
    handler = (url) =>
      url.endsWith('/print-model')
        ? { status: 422, body: { error: { code: 'company_profile_missing', message: 'x' } } }
        : { body: current };
    await userEvent.click(screen.getByRole('button', { name: 'Print preview' }));
    expect(await screen.findByText('Could not load the print preview')).toBeInTheDocument();
  });

  it('downloads the PDF through an authenticated request', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' });
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(((url: string, init: RequestInit) => {
      if (url === '/quotations/q1/pdf') {
        return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(blob) });
      }
      return (original as (u: string, i: RequestInit) => Promise<unknown>)(url, init);
    }) as typeof fetch);
    const createObjectURL = vi.fn(() => 'blob:pdf');
    const openWindow = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL }));
    vi.stubGlobal('open', openWindow);
    open('/quotations/q1');
    await screen.findByText('QUO-2026-0001');
    await userEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith('blob:pdf', '_blank'));
    expect(createObjectURL).toHaveBeenCalledWith(blob);
  });

  it('reports a failed load', async () => {
    handler = () => ({
      status: 404,
      body: { error: { code: 'quotation_not_found', message: 'x' } },
    });
    open('/quotations/q1');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});
