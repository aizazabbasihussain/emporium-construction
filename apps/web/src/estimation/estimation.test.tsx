import { estimationPermissions } from '@emporium/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { Estimate, Preview, TemplateParameter } from './api';
import { FormulaPreview } from './FormulaPreview';
import { MarginPanel } from './MarginPanel';

type Reply = { status?: number; body: unknown };
type Handler = (url: string, init: RequestInit) => Reply | undefined;
let handler: Handler;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

const preview: Preview = {
  rateMissingCount: 0,
  totals: {
    companyCost: '342000.00',
    clientSuppliedValue: '0.00',
    overheadAmount: '34200.00',
    contingencyAmount: '17100.00',
    totalCost: '393300.00',
    proposedPrice: '400000.00',
    expectedMargin: '6700.00',
    marginPercent: '1.6750',
    targetMarginPercent: '15.0000',
    meetsTarget: false,
  },
};

const estimate: Estimate = {
  id: 'e1',
  number: 'EST-0001',
  revision: 1,
  leadId: null,
  partyId: null,
  templateId: null,
  title: 'Boundary wall',
  workType: 'boundary_wall',
  sector: 'private',
  status: 'draft',
  parentEstimateId: null,
  parameterValues: {},
  overheadPercent: '10.0000',
  contingencyPercent: '5.0000',
  targetMarginPercent: '15.0000',
  proposedPrice: '400000.00',
  lockedAt: null,
  version: 4,
  lines: [
    {
      lineNo: 1,
      description: 'Bricks',
      lineKind: 'material',
      itemId: null,
      costCodeId: 'cc1',
      unitCode: 'nos',
      quantity: '8100.0000',
      rate: '20.0000',
      suppliedBy: 'company',
      note: null,
      lineTotal: '162000.00',
      rateMissing: false,
    },
    {
      lineNo: 2,
      description: 'Mason days',
      lineKind: 'labour',
      itemId: null,
      costCodeId: 'cc2',
      unitCode: 'day',
      quantity: '12.0000',
      rate: '0.0000',
      suppliedBy: 'company',
      note: null,
      lineTotal: '0.00',
      rateMissing: true,
    },
  ],
};

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = (url) => {
    if (url.startsWith('/estimation/estimates/preview')) return { body: preview };
    if (url.startsWith('/estimation/estimates/e1')) return { body: estimate };
    if (url.startsWith('/master/cost-codes')) {
      return {
        body: page([
          { id: 'cc1', code: '100', name: 'Materials', kind: 'material' },
          { id: 'cc2', code: '200', name: 'Labour', kind: 'labour' },
        ]),
      };
    }
    if (url.startsWith('/master/units')) {
      return { body: page([{ code: 'nos' }, { code: 'day' }]) };
    }
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

const parameters: TemplateParameter[] = [
  { key: 'length', label: 'Length', unit: 'ft' },
  { key: 'height', label: 'Height', unit: 'ft' },
];

const withQuery = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {node}
  </QueryClientProvider>
);

const open = (path: string) =>
  render(
    <AppProviders auth={fakeAuth()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

describe('formula preview (spec P1-07 T-7)', () => {
  it('sends the sample values and shows each formula result or error', async () => {
    handler = () => ({
      body: {
        results: [
          { formula: 'length * height', ok: true, quantity: '600.0000', errorCode: null },
          {
            formula: 'length / 0',
            ok: false,
            quantity: null,
            errorCode: 'formula_division_by_zero',
          },
          { formula: 'weird', ok: false, quantity: null, errorCode: 'something_new' },
        ],
      },
    });
    render(
      withQuery(
        <FormulaPreview
          parameters={parameters}
          formulas={['length * height', 'length / 0', 'weird']}
        />,
      ),
    );
    await userEvent.type(screen.getByLabelText('Sample value for Length'), '100');
    await userEvent.type(screen.getByLabelText('Sample value for Height'), '6');
    await userEvent.click(screen.getByRole('button', { name: 'Preview formulas' }));

    expect(await screen.findByText('= 600.0000', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('The formula divides by zero.')).toBeInTheDocument();
    expect(screen.getByText('something_new')).toBeInTheDocument();
    expect(calls[0]).toMatchObject({
      url: '/estimation/formula-preview',
      method: 'POST',
      body: {
        parameters,
        values: { length: '100', height: '6' },
        formulas: ['length * height', 'length / 0', 'weird'],
      },
    });
  });

  it('says when the preview could not run', async () => {
    handler = () => ({ status: 500, body: { error: { code: 'boom', message: 'boom' } } });
    render(withQuery(<FormulaPreview parameters={[]} formulas={['1']} />));
    await userEvent.click(screen.getByRole('button', { name: 'Preview formulas' }));
    expect(await screen.findByText('Could not preview the formulas')).toBeInTheDocument();
  });
});

describe('margin panel (BR-5 to BR-7)', () => {
  const terms = {
    overheadPercent: '10',
    contingencyPercent: '5',
    targetMarginPercent: '15',
    proposedPrice: '400000',
  };
  const lines = estimate.lines;

  it('shows the figures the API worked out and compares the margin with the target', async () => {
    render(withQuery(<MarginPanel lines={lines} terms={terms} />));
    expect(await screen.findByText('393,300.00')).toBeInTheDocument();
    expect(screen.getByText('342,000.00')).toBeInTheDocument();
    expect(screen.getByText('1.6750%')).toBeInTheDocument();
    expect(screen.getByText('Below the 15.0000% target')).toBeInTheDocument();
    expect(calls[0]).toMatchObject({
      url: '/estimation/estimates/preview',
      body: {
        ...terms,
        lines: [{ lineKind: 'material', quantity: '8100.0000', rate: '20.0000' }, {}],
      },
    });
  });

  it('warns about lines without a rate and shows a met target', async () => {
    handler = () => ({
      body: {
        rateMissingCount: 2,
        totals: { ...preview.totals, meetsTarget: true, proposedPrice: null, marginPercent: null },
      },
    });
    render(withQuery(<MarginPanel lines={lines} terms={terms} />));
    expect(
      await screen.findByText('2 line(s) have no rate. Price them before locking.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Meets the 15.0000% target')).toBeInTheDocument();
  });

  it('says when the totals could not be worked out', async () => {
    handler = () => ({ status: 400, body: { error: { code: 'invalid_rate', message: 'bad' } } });
    render(withQuery(<MarginPanel lines={lines} terms={terms} />));
    expect(await screen.findByText('Could not work out the totals')).toBeInTheDocument();
  });
});

describe('estimate editor', () => {
  it('lets a draft be edited, flags the missing rate and locks it', async () => {
    open('/estimation/estimates/e1');
    expect(await screen.findByText('EST-0001')).toBeInTheDocument();
    expect(screen.getAllByText('Rate missing').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Create revision' })).not.toBeInTheDocument();

    handler = (url) =>
      url.endsWith('/lock')
        ? { status: 422, body: { error: { code: 'rate_missing', message: 'x' } } }
        : { body: preview };
    await userEvent.click(screen.getByRole('button', { name: 'Lock estimate' }));
    expect(
      await screen.findByText('Some lines have no rate. Price them before locking.'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith('/lock'))).toMatchObject({
      method: 'POST',
      body: { version: 4 },
    });
  });

  it('saves the edited lines with the version', async () => {
    open('/estimation/estimates/e1');
    await screen.findByText('EST-0001');
    const rates = screen.getAllByLabelText('Rate');
    await userEvent.clear(rates[1] as HTMLElement);
    await userEvent.type(rates[1] as HTMLElement, '2500');
    handler = (url) => ({ body: url.includes('/preview') ? preview : estimate });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/estimation/estimates/e1');
    expect(put?.body).toMatchObject({
      version: 4,
      proposedPrice: '400000.00',
      lines: [{ rate: '20.0000' }, { rate: '2500' }],
    });
  });

  it('shows a locked estimate read-only and offers a revision', async () => {
    handler = (url) =>
      url.startsWith('/estimation/estimates/e1')
        ? { body: { ...estimate, status: 'locked', lockedAt: '2026-10-25T10:00:00.000Z' } }
        : url.startsWith('/estimation/estimates/preview')
          ? { body: preview }
          : undefined;
    open('/estimation/estimates/e1');
    expect(
      await screen.findByText(
        'This estimate is locked and cannot be edited. Revise it to make changes.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lock estimate' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.getAllByLabelText('Quantity')[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create revision' })).toBeEnabled();
  });

  it('hides the save and lock buttons from a user who may only read', async () => {
    permissions = [estimationPermissions.estimateRead];
    open('/estimation/estimates/e1');
    await screen.findByText('EST-0001');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lock estimate' })).not.toBeInTheDocument();
  });
});

describe('lists', () => {
  it('lists templates and offers the editor to those who manage them', async () => {
    handler = (url) =>
      url.startsWith('/estimation/templates')
        ? {
            body: page([
              {
                id: 't1',
                code: 'WALL',
                name: 'Boundary wall',
                workType: 'boundary_wall',
                active: true,
                version: 1,
              },
            ]),
          }
        : undefined;
    open('/estimation/templates');
    expect(await screen.findByText('WALL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New template' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit WALL' })).toBeInTheDocument();
  });

  it('lists estimates and links to the editor', async () => {
    handler = (url) =>
      url.startsWith('/estimation/estimates')
        ? { body: page([{ ...estimate, lines: undefined }]) }
        : undefined;
    open('/estimation/estimates');
    expect(await screen.findByRole('link', { name: 'EST-0001 / 1' })).toHaveAttribute(
      'href',
      '/estimation/estimates/e1',
    );
    expect(screen.getByRole('button', { name: 'New estimate' })).toBeInTheDocument();
  });

  it('keeps the estimate pages from a user without the permission', async () => {
    permissions = [];
    open('/estimation/estimates');
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});
