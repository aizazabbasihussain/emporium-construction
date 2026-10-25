import { valuationPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

const CATEGORY = '018f0000-0000-7000-8000-0000000000c1';
const ITEM = '018f0000-0000-7000-8000-0000000000a1';

const policies = [
  {
    id: 'p1',
    scope: 'company',
    categoryId: null,
    method: 'weighted_average',
    effectiveFrom: '2000-01-01',
    status: 'active',
    requestedBy: null,
    approvedBy: null,
    createdAt: '2000-01-01T00:00:00.000Z',
  },
  {
    id: 'p2',
    scope: 'category',
    categoryId: CATEGORY,
    method: 'fifo',
    effectiveFrom: '2020-01-01',
    status: 'active',
    requestedBy: null,
    approvedBy: null,
    createdAt: '2020-01-01T00:00:00.000Z',
  },
  {
    id: 'p3',
    scope: 'company',
    categoryId: null,
    method: 'fifo',
    effectiveFrom: '2099-01-01',
    status: 'pending_approval',
    requestedBy: null,
    approvedBy: null,
    createdAt: '2026-10-25T00:00:00.000Z',
  },
];

const stockValue = {
  items: [
    {
      storeId: 'store-main',
      itemId: ITEM,
      categoryId: CATEGORY,
      method: 'fifo',
      quantity: '150.0000',
      value: '190000.00',
      averageCost: '1266.6667',
    },
  ],
  totalValue: '190000.00',
};

const transition = {
  id: 't1',
  storeId: 'store-main',
  itemId: ITEM,
  fromMethod: 'weighted_average',
  toMethod: 'fifo',
  quantity: '150.0000',
  valueBefore: '187500.00',
  valueAfter: '187500.00',
  policyId: 'p3',
  completedAt: '2026-10-26T05:00:00.000Z',
};

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = (url, init) => {
    if (url === '/valuation/policies' && init.method === 'POST') {
      return { status: 201, body: { ...policies[2], id: 'p4' } };
    }
    if (url === '/valuation/policies') return { body: { items: policies } };
    if (url.startsWith('/valuation/stock-value')) return { body: stockValue };
    if (url.startsWith('/valuation/transitions/run')) return { body: { items: [transition] } };
    if (url.startsWith('/valuation/transitions')) return { body: page([transition]) };
    if (url.startsWith('/master/item-categories')) {
      return {
        body: page([
          { id: CATEGORY, code: 'CEM', name: 'Cement', parentId: null, version: 1 },
          { id: 'c2', code: 'STL', name: 'Steel', parentId: null, version: 1 },
        ]),
      };
    }
    if (url.startsWith('/master/items')) {
      return { body: page([{ id: ITEM, code: 'OPC', name: 'OPC cement 50 kg', version: 1 }]) };
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

describe('valuation settings (T-10)', () => {
  it('shows the company default, the category overrides and the pending changes', async () => {
    open('/valuation/settings');
    expect(await screen.findByText('Stock valuation settings')).toBeInTheDocument();
    expect(await screen.findByText('Cement')).toBeInTheDocument();
    expect(screen.getAllByText('Weighted average').length).toBeGreaterThan(0);
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText('Category overrides')).toBeInTheDocument();
    expect(screen.getByText('Upcoming and pending changes')).toBeInTheDocument();
  });

  it('asks for each missing field before sending a request', async () => {
    open('/valuation/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a change' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(dialog).findByText('Choose a method.')).toBeInTheDocument();

    await choose('Method', 'First in, first out (FIFO)');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(dialog).findByText('Choose the start date.')).toBeInTheDocument();

    await choose('Applies to', 'Category override');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(dialog).findByText('Choose a category.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('sends a category request and confirms it', async () => {
    open('/valuation/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a change' }));
    const dialog = await screen.findByRole('dialog');
    await choose('Applies to', 'Category override');
    await choose('Category', 'Steel');
    await choose('Method', 'First in, first out (FIFO)');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2099-02-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Sent for approval.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/valuation/policies',
      body: { scope: 'category', categoryId: 'c2', method: 'fifo', effectiveFrom: '2099-02-01' },
    });
  });

  it('sends a company request without a category', async () => {
    open('/valuation/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a change' }));
    const dialog = await screen.findByRole('dialog');
    await choose('Method', 'Weighted average');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2099-03-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      scope: 'company',
      method: 'weighted_average',
    });
  });

  it('shows the server answer when the request is refused', async () => {
    const original = handler;
    handler = (url, init) =>
      url === '/valuation/policies' && init.method === 'POST'
        ? { status: 422, body: { error: { code: 'policy_back_dated', message: 'past' } } }
        : original(url, init);
    open('/valuation/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Request a change' }));
    const dialog = await screen.findByRole('dialog');
    await choose('Method', 'Weighted average');
    await userEvent.type(within(dialog).getByLabelText('Starts on'), '2099-03-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(
      await within(dialog).findByText('A policy cannot start in the past.'),
    ).toBeInTheDocument();
  });

  it('hides the request button from those who may only read', async () => {
    permissions = [valuationPermissions.policyRead];
    open('/valuation/settings');
    expect(await screen.findByText('Stock valuation settings')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request a change' })).not.toBeInTheDocument();
  });

  it('says so when there is no company policy and no category list', async () => {
    handler = (url) =>
      url === '/valuation/policies'
        ? { body: { items: [] } }
        : url.startsWith('/master/')
          ? { status: 403, body: { error: { code: 'forbidden', message: 'no' } } }
          : undefined;
    open('/valuation/settings');
    expect(await screen.findByText('No company policy is in force.')).toBeInTheDocument();
    expect(screen.getByText('No category has its own method.')).toBeInTheDocument();
    expect(screen.getByText('No changes are planned.')).toBeInTheDocument();
  });
});

describe('valuation report', () => {
  it('lists stock value with the method and the total', async () => {
    open('/valuation/report');
    expect(await screen.findByText('OPC cement 50 kg')).toBeInTheDocument();
    expect(screen.getByText('First in, first out (FIFO)')).toBeInTheDocument();
    expect(screen.getByText('store-main')).toBeInTheDocument();
    expect(screen.getByText('Total value')).toBeInTheDocument();
    expect(await screen.findAllByText(/1,90,000|190,000/)).not.toHaveLength(0);
  });

  it('filters by category', async () => {
    open('/valuation/report');
    await screen.findByText('OPC cement 50 kg');
    await choose('Category', 'Cement');
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/valuation/stock-value?category=${CATEGORY}`)).toBe(true),
    );
  });

  it('shows ids when names cannot be read and an error when the report fails', async () => {
    handler = (url) =>
      url.startsWith('/valuation/stock-value')
        ? { status: 500, body: { error: { code: 'x', message: 'x' } } }
        : { status: 403, body: { error: { code: 'forbidden', message: 'no' } } };
    open('/valuation/report');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });

  it('falls back to the item id when the item list is not readable', async () => {
    const original = handler;
    handler = (url, init) =>
      url.startsWith('/master/items')
        ? { status: 403, body: { error: { code: 'forbidden', message: 'no' } } }
        : original(url, init);
    open('/valuation/report');
    expect(await screen.findByText(ITEM)).toBeInTheDocument();
  });
});

describe('valuation transitions', () => {
  it('shows the log and runs the transitions now', async () => {
    open('/valuation/transitions');
    expect(
      await screen.findByText('Valuation transitions', { selector: 'h3' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('store-main')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run transitions now' }));
    expect(await screen.findByText('1 converted.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/valuation/transitions/run');
  });

  it('shows why a run failed', async () => {
    const original = handler;
    handler = (url, init) =>
      url.startsWith('/valuation/transitions/run')
        ? { status: 422, body: { error: { code: 'transition_value_mismatch', message: 'm' } } }
        : original(url, init);
    open('/valuation/transitions');
    await userEvent.click(await screen.findByRole('button', { name: 'Run transitions now' }));
    expect(
      await screen.findByText(
        'The conversion would change the stock value, so nothing was changed.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a generic error for an unexpected failure', async () => {
    const original = handler;
    handler = (url, init) =>
      url.startsWith('/valuation/transitions/run')
        ? { status: 500, body: {} }
        : original(url, init);
    open('/valuation/transitions');
    await userEvent.click(await screen.findByRole('button', { name: 'Run transitions now' }));
    expect(await screen.findByText('Request failed')).toBeInTheDocument();
  });

  it('hides the run button from those who may only read the log', async () => {
    permissions = [valuationPermissions.reportRead];
    open('/valuation/transitions');
    expect(await screen.findByText('store-main')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run transitions now' })).not.toBeInTheDocument();
  });

  it('is closed to people without the report permission', async () => {
    permissions = [valuationPermissions.policyRead];
    open('/valuation/transitions');
    await waitFor(() =>
      expect(screen.queryByText('Valuation transitions', { selector: 'h3' })).toBeNull(),
    );
  });
});
