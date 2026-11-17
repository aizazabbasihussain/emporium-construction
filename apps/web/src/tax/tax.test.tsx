import { taxPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { checkRange, checkRate, firstProblem, optional } from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

// Synthetic test values; the screens ship with no rate (spec P2-01 BR-9).
const decided = { note: null, effectiveTo: null, status: 'active' };
const overview = {
  items: [
    {
      ...decided,
      id: 'r1',
      authorityCode: 'FBR',
      supplyKind: 'services',
      nature: null,
      ratePercent: '10.0000',
      taxCode: 'TEST-ST',
      effectiveFrom: '2026-01-01',
    },
    {
      ...decided,
      id: 'r2',
      authorityCode: 'FBR',
      supplyKind: 'goods',
      nature: 'civil',
      ratePercent: '5.0000',
      taxCode: 'TEST-GS',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30',
      status: 'pending_approval',
    },
  ],
  authorities: [
    { code: 'FBR', name: 'Federal Board of Revenue', registrationType: 'strn' },
    { code: 'PRA', name: 'Punjab Revenue Authority', registrationType: 'pra' },
  ],
  regionMap: [
    {
      ...decided,
      id: 'm1',
      region: 'punjab',
      supplyKind: 'services',
      authorityCode: 'PRA',
      effectiveFrom: '2026-01-01',
    },
  ],
  settings: { roundingMode: 'per_document', pricesIncludeTax: false },
};

const withholding = [
  {
    ...decided,
    id: 'w1',
    direction: 'we_withhold',
    authorityCode: 'FBR',
    partyType: 'vendor',
    nature: 'civil',
    ratePercent: '2.0000',
    base: 'on_base',
    effectiveFrom: '2026-01-01',
  },
  {
    ...decided,
    id: 'w2',
    direction: 'client_withholds',
    authorityCode: 'FBR',
    partyType: null,
    nature: 'civil',
    ratePercent: '1.0000',
    base: 'on_invoice_total',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
  },
];

const totals = (base: string, tax: string, documents: number) => ({ base, tax, documents });

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = (url, init) => {
    if (url === '/tax/rules' && init.method === 'POST')
      return { status: 201, body: overview.items[0] };
    if (url === '/tax/region-map' && init.method === 'POST')
      return { status: 201, body: overview.regionMap[0] };
    if (url === '/tax/withholding-rules' && init.method === 'POST')
      return { status: 201, body: withholding[0] };
    if (url === '/tax/rules') return { body: overview };
    if (url === '/tax/withholding-rules') return { body: { items: withholding } };
    if (url.startsWith('/tax/reports')) {
      return {
        body: {
          authorityCode: 'FBR',
          month: '2026-10',
          outputTax: totals('1300.00', '130.00', 3),
          inputTax: totals('300.00', '30.00', 1),
          withholdingDeducted: totals('0.00', '0.00', 0),
          withholdingSuffered: totals('0.00', '0.00', 0),
        },
      };
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
      const { status = 200, body } = handler(url, init) ?? { body: { items: [] } };
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

const choose = async (label: string, option: string) => {
  await userEvent.click(screen.getByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByTitle(option));
};

const send = (dialog: HTMLElement) =>
  userEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));

describe('form checks', () => {
  it('checks the rate', () => {
    expect(checkRate('')).toBe('rateRequired');
    expect(checkRate('abc')).toBe('rateInvalid');
    expect(checkRate('1.23456')).toBe('rateInvalid');
    expect(checkRate('100.5')).toBe('rateTooHigh');
    expect(checkRate('100')).toBeNull();
    expect(checkRate('0')).toBeNull();
  });

  it('checks the dates', () => {
    expect(checkRange('', '')).toBe('dateRequired');
    expect(checkRange('2026-02-01', '2026-01-01')).toBe('rangeInvalid');
    expect(checkRange('2026-01-01', '')).toBeNull();
    expect(checkRange('2026-01-01', '2026-01-01')).toBeNull();
  });

  it('reports the first problem of a form', () => {
    const ok = { authorityCode: 'FBR', from: '2026-01-01', to: '' };
    expect(firstProblem({ ...ok, authorityCode: undefined })).toBe('authorityRequired');
    expect(firstProblem({ ...ok, rate: '' })).toBe('rateRequired');
    expect(firstProblem({ ...ok, rate: '5', taxCode: ' ' })).toBe('taxCodeRequired');
    expect(firstProblem({ ...ok, natureRequired: true })).toBe('natureRequired');
    expect(firstProblem({ ...ok, natureRequired: true, nature: 'civil' })).toBeNull();
    expect(firstProblem({ ...ok, from: '' })).toBe('dateRequired');
    expect(firstProblem({ ...ok, rate: '5', taxCode: 'X' })).toBeNull();
  });

  it('leaves out blank optional text', () => {
    expect(optional('  ')).toBeUndefined();
    expect(optional(' civil ')).toBe('civil');
  });
});

describe('sales tax rules page', () => {
  it('lists the rules with their dates and status, and the company settings', async () => {
    open('/tax/rules');
    expect(await screen.findByText('Sales tax rules', { selector: 'h3' })).toBeInTheDocument();
    expect(await screen.findByText('TEST-ST')).toBeInTheDocument();
    expect(screen.getByText('10.0000 %')).toBeInTheDocument();
    expect(screen.getByText('Any nature')).toBeInTheDocument();
    expect(screen.getByText('civil')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getAllByText('Open').length).toBeGreaterThan(0);
    expect(screen.getByText(/Tax is rounded once on the whole document/)).toBeInTheDocument();
    expect(screen.getByText(/Prices are entered without tax/)).toBeInTheDocument();
  });

  it('says so when there are no rules, and shows the tax-included basis', async () => {
    handler = (url) =>
      url === '/tax/rules'
        ? {
            body: {
              ...overview,
              items: [],
              settings: { roundingMode: 'per_line', pricesIncludeTax: true },
            },
          }
        : undefined;
    open('/tax/rules');
    expect(await screen.findByText(/No sales tax rules yet/)).toBeInTheDocument();
    expect(await screen.findByText(/Tax is rounded on each line/)).toBeInTheDocument();
    expect(screen.getByText(/Prices include tax/)).toBeInTheDocument();
  });

  it('asks for each missing field before sending', async () => {
    open('/tax/rules');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a rule' }));
    const dialog = await screen.findByRole('dialog');
    await send(dialog);
    expect(await within(dialog).findByText('Choose an authority.')).toBeInTheDocument();

    await choose('Authority', 'FBR - Federal Board of Revenue');
    await send(dialog);
    expect(await within(dialog).findByText('Enter the rate.')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Rate (%)'), '150');
    await send(dialog);
    expect(
      await within(dialog).findByText('The rate cannot be more than 100.'),
    ).toBeInTheDocument();

    await userEvent.clear(within(dialog).getByLabelText('Rate (%)'));
    await userEvent.type(within(dialog).getByLabelText('Rate (%)'), '8');
    await send(dialog);
    expect(await within(dialog).findByText('Enter the tax code.')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Tax code'), 'X1');
    await send(dialog);
    expect(await within(dialog).findByText('Choose the start date.')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2026-05-01');
    await userEvent.type(within(dialog).getByLabelText('Ends on'), '2026-04-01');
    await send(dialog);
    expect(
      await within(dialog).findByText('The rule cannot end before it starts.'),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('sends the request and confirms it', async () => {
    open('/tax/rules');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a rule' }));
    const dialog = await screen.findByRole('dialog');
    await choose('Authority', 'PRA - Punjab Revenue Authority');
    await choose('Supply', 'Goods');
    await userEvent.type(within(dialog).getByLabelText('Nature of work'), 'civil');
    await userEvent.type(within(dialog).getByLabelText('Rate (%)'), '7.5');
    await userEvent.type(within(dialog).getByLabelText('Tax code'), 'X1');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2026-07-01');
    await send(dialog);
    expect(await screen.findByText(/Sent for approval/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/tax/rules',
      body: {
        authorityCode: 'PRA',
        supplyKind: 'goods',
        nature: 'civil',
        ratePercent: '7.5',
        taxCode: 'X1',
        effectiveFrom: '2026-07-01',
      },
    });
  });

  it('defaults the supply to services and leaves a blank nature out', async () => {
    open('/tax/rules');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a rule' }));
    const dialog = await screen.findByRole('dialog');
    await choose('Authority', 'FBR - Federal Board of Revenue');
    await userEvent.type(within(dialog).getByLabelText('Rate (%)'), '0');
    await userEvent.type(within(dialog).getByLabelText('Tax code'), 'Z');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2026-07-01');
    await send(dialog);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const body = calls.find((c) => c.method === 'POST')?.body;
    expect(body).toMatchObject({ supplyKind: 'services', ratePercent: '0' });
    expect(body).not.toHaveProperty('nature');
  });

  it('shows the answer of the server when the request is refused, or a general error', async () => {
    const original = handler;
    handler = (url, init) =>
      url === '/tax/rules' && init.method === 'POST'
        ? { status: 422, body: { error: { code: 'tax_rule_overlap', message: 'overlap' } } }
        : original(url, init);
    open('/tax/rules');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a rule' }));
    const dialog = await screen.findByRole('dialog');
    await choose('Authority', 'FBR - Federal Board of Revenue');
    await userEvent.type(within(dialog).getByLabelText('Rate (%)'), '8');
    await userEvent.type(within(dialog).getByLabelText('Tax code'), 'X1');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2026-01-01');
    await send(dialog);
    expect(
      await within(dialog).findByText(
        'The dates overlap an existing rule. Start the new rule after it.',
      ),
    ).toBeInTheDocument();

    handler = (url, init) => {
      if (url === '/tax/rules' && init.method === 'POST') throw new Error('network down');
      return original(url, init);
    };
    await send(dialog);
    expect(await within(dialog).findByText(/Could not save|save/i)).toBeInTheDocument();
  });

  it('hides the request button from those who may only read', async () => {
    permissions = [taxPermissions.ruleRead];
    open('/tax/rules');
    expect(await screen.findByText('TEST-ST')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request a rule' })).not.toBeInTheDocument();
  });

  it('shows a load error', async () => {
    handler = () => ({ status: 500, body: { error: { code: 'x', message: 'boom' } } });
    open('/tax/rules');
    expect(await screen.findByText(/load/i)).toBeInTheDocument();
  });
});

describe('authorities and region map page', () => {
  it('shows the authorities and the mapping', async () => {
    open('/tax/region-map');
    expect(await screen.findByText('Tax authorities and regions')).toBeInTheDocument();
    expect(await screen.findByText('Federal Board of Revenue')).toBeInTheDocument();
    expect(screen.getByText('Punjab Revenue Authority')).toBeInTheDocument();
    expect(screen.getAllByText('Punjab').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Services').length).toBeGreaterThan(0);
  });

  it('says so when nothing is mapped', async () => {
    handler = (url) =>
      url === '/tax/rules' ? { body: { ...overview, regionMap: [] } } : undefined;
    open('/tax/region-map');
    expect(await screen.findByText('No region is mapped yet.')).toBeInTheDocument();
  });

  it('requests a mapping, checking the authority first', async () => {
    open('/tax/region-map');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a mapping' }));
    const dialog = await screen.findByRole('dialog');
    await send(dialog);
    expect(await within(dialog).findByText('Choose an authority.')).toBeInTheDocument();
    await choose('Region', 'Punjab');
    await choose('Authority', 'PRA - Punjab Revenue Authority');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2026-07-01');
    await userEvent.type(within(dialog).getByLabelText('Ends on'), '2026-12-31');
    await send(dialog);
    expect(await screen.findByText(/Sent for approval/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/tax/region-map',
      body: {
        region: 'punjab',
        supplyKind: 'services',
        authorityCode: 'PRA',
        effectiveFrom: '2026-07-01',
        effectiveTo: '2026-12-31',
      },
    });
  });

  it('defaults the region and hides the button from readers', async () => {
    open('/tax/region-map');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a mapping' }));
    const dialog = await screen.findByRole('dialog');
    await choose('Authority', 'FBR - Federal Board of Revenue');
    await choose('Supply', 'Goods');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2026-07-01');
    await send(dialog);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      region: 'islamabad',
      supplyKind: 'goods',
    });
  });

  it('hides the request button from those who may only read', async () => {
    permissions = [taxPermissions.ruleRead];
    open('/tax/region-map');
    expect(await screen.findByText('Federal Board of Revenue')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request a mapping' })).not.toBeInTheDocument();
  });
});

describe('withholding rules page', () => {
  it('lists the rules', async () => {
    open('/tax/withholding');
    expect(await screen.findByText('Withheld by us')).toBeInTheDocument();
    expect(screen.getByText('Withheld by the client')).toBeInTheDocument();
    expect(screen.getByText('vendor')).toBeInTheDocument();
    expect(screen.getByText('Any party')).toBeInTheDocument();
    expect(screen.getByText('Amount before tax')).toBeInTheDocument();
    expect(screen.getByText('Invoice total')).toBeInTheDocument();
    expect(screen.getByText('2.0000 %')).toBeInTheDocument();
  });

  it('says so when there are none', async () => {
    handler = (url) => (url === '/tax/withholding-rules' ? { body: { items: [] } } : undefined);
    open('/tax/withholding');
    expect(await screen.findByText('No withholding rules yet.')).toBeInTheDocument();
  });

  it('asks for the nature and the rate, then sends the request', async () => {
    open('/tax/withholding');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a rule' }));
    const dialog = await screen.findByRole('dialog');
    await choose('Authority', 'FBR - Federal Board of Revenue');
    await userEvent.type(within(dialog).getByLabelText('Rate (%)'), '2');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2026-07-01');
    await send(dialog);
    expect(await within(dialog).findByText('Enter the nature of work.')).toBeInTheDocument();

    await choose('Who withholds', 'Withheld by us');
    await choose('Applied to', 'Tax amount');
    await userEvent.type(within(dialog).getByLabelText('Party type'), 'vendor');
    await userEvent.type(within(dialog).getByLabelText('Nature of work'), 'civil');
    await send(dialog);
    expect(await screen.findByText(/Sent for approval/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/tax/withholding-rules',
      body: {
        direction: 'we_withhold',
        authorityCode: 'FBR',
        partyType: 'vendor',
        nature: 'civil',
        ratePercent: '2',
        base: 'on_tax_amount',
      },
    });
  });

  it('uses the defaults for direction and base and hides the button from readers', async () => {
    open('/tax/withholding');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a rule' }));
    const dialog = await screen.findByRole('dialog');
    await choose('Authority', 'FBR - Federal Board of Revenue');
    await userEvent.type(within(dialog).getByLabelText('Nature of work'), 'civil');
    await userEvent.type(within(dialog).getByLabelText('Rate (%)'), '1');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2026-07-01');
    await send(dialog);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      direction: 'client_withholds',
      base: 'on_invoice_total',
    });
  });

  it('hides the request button from those who may only read', async () => {
    permissions = [taxPermissions.ruleRead];
    open('/tax/withholding');
    expect(await screen.findByText('Withheld by us')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request a rule' })).not.toBeInTheDocument();
  });
});

describe('tax report page', () => {
  it('shows the figures for the first authority and the chosen month', async () => {
    open('/tax/report');
    expect(await screen.findByText('Output tax (invoices less credit notes)')).toBeInTheDocument();
    expect(screen.getByText('Input tax (vendor bills)')).toBeInTheDocument();
    expect(screen.getByText('Withholding we deducted')).toBeInTheDocument();
    expect(screen.getByText('Withholding clients deducted')).toBeInTheDocument();
    expect(await screen.findAllByText(/1,300\.00|1300\.00/)).not.toHaveLength(0);
    expect(calls.some((c) => c.url.startsWith('/tax/reports?authority=FBR&month='))).toBe(true);
  });

  it('asks again when the authority or month changes', async () => {
    open('/tax/report');
    await screen.findByText('Input tax (vendor bills)');
    await choose('Authority', 'PRA - Punjab Revenue Authority');
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith('/tax/reports?authority=PRA'))).toBe(true),
    );
    const month = screen.getByLabelText('Month');
    await userEvent.clear(month);
    await userEvent.type(month, '2026-10');
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/tax/reports?authority=PRA&month=2026-10')).toBe(true),
    );
  });

  it('prompts when there is nothing to show, and reports a load error', async () => {
    handler = (url) => {
      if (url === '/tax/rules') return { body: overview };
      return url.startsWith('/tax/reports')
        ? { status: 500, body: { error: { code: 'x', message: 'boom' } } }
        : undefined;
    };
    open('/tax/report');
    expect(await screen.findByText(/load/i)).toBeInTheDocument();
  });
});
