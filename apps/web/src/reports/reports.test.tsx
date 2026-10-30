import { reportsPermissions } from '@emporium/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string }[] = [];

const PROJECT = '018f0000-0000-7000-8000-0000000000p1';
const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

const projectCost = {
  code: 'project-cost',
  filters: {},
  columns: [
    { key: 'projectCode', type: 'text' },
    { key: 'budget', type: 'money' },
    { key: 'percentUsed', type: 'percent' },
    { key: 'expectedDate', type: 'date' },
  ],
  items: [
    {
      projectCode: 'P-001',
      budget: '1000000.00',
      percentUsed: '55.00',
      expectedDate: '2026-10-22',
    },
    { projectCode: 'P-002', budget: null, percentUsed: null, expectedDate: null },
  ],
  total: 2,
  limit: 50,
  offset: 0,
  totals: { budget: '1000000.00' },
  extras: [
    {
      key: 'projects',
      columns: [
        { key: 'projectCode', type: 'text' },
        { key: 'used', type: 'money' },
      ],
      rows: [{ projectCode: 'P-001', used: '550000.00' }],
      totals: { projectCode: 'Total', used: '550000.00' },
    },
    {
      key: 'headcount',
      columns: [{ key: 'headcount', type: 'int' }],
      rows: [],
      totals: null,
    },
  ],
};

const emptyReport = { ...projectCost, items: [], total: 0, totals: null, extras: [] };

const savedFilter = {
  id: 's1',
  reportCode: 'project-cost',
  name: 'Main project',
  filter: { projectId: PROJECT },
  version: 2,
};

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = (url, init) => {
    if (url.startsWith('/reports/saved-filters') && init.method === 'POST') {
      return { status: 201, body: savedFilter };
    }
    if (url.startsWith('/reports/saved-filters') && init.method === 'DELETE') {
      return { body: { id: 's1' } };
    }
    if (url.startsWith('/reports/saved-filters')) return { body: { items: [savedFilter] } };
    if (url.startsWith('/reports/project-cost')) return { body: projectCost };
    if (url.startsWith('/reports/')) return { body: emptyReport };
    if (url.startsWith('/projects')) {
      return {
        body: page([{ id: PROJECT, code: 'P-001', name: 'Tower', version: 1 }]),
      };
    }
    return undefined;
  };
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((fullUrl: string, init: RequestInit) => {
      // A local apps/web/.env may set VITE_API_URL; the handlers match on the path only.
      const url = fullUrl.replace(/^https?:\/\/[^/]+/, '');
      if (url === '/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(profileOf(permissions)),
        });
      }
      calls.push({ url, method: init.method ?? 'GET' });
      const { status = 200, body } = handler(url, init) ?? {
        body: /^\/reports\/(?!saved)/.test(url) ? emptyReport : page([]),
      };
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
        blob: () => Promise.resolve(new Blob(['x'])),
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

const reportCalls = () => calls.filter((c) => /^\/reports\/(?!saved)/.test(c.url));
const lastReport = () => reportCalls()[reportCalls().length - 1]?.url ?? '';

const choose = async (label: string, option: string) => {
  await userEvent.click(screen.getByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByTitle(option));
};

describe('reports hub', () => {
  it('lists every report for a user who holds all report permissions', async () => {
    open('/reports');
    expect(await screen.findByText('Project cost status')).toBeInTheDocument();
    expect(screen.getByText('Lead pipeline')).toBeInTheDocument();
    expect(screen.getAllByText('Client material').length).toBeGreaterThan(0);
  });

  it('lists only the reports the user may open', async () => {
    permissions = [reportsPermissions.pipelineRead];
    open('/reports');
    expect(await screen.findByText('Lead pipeline')).toBeInTheDocument();
    expect(screen.queryByText('Project cost status')).not.toBeInTheDocument();
  });

  it('shows the forbidden page to a user with no report permission', async () => {
    permissions = [];
    open('/reports');
    expect(await screen.findByText(/not allowed|forbidden|permission/i)).toBeInTheDocument();
  });
});

describe('report page', () => {
  it('shows rows, totals and the extra tables', async () => {
    open('/reports/project-cost');
    expect(await screen.findAllByText('P-001')).not.toHaveLength(0);
    expect(screen.getByText('Project totals')).toBeInTheDocument();
    expect(screen.getByText('Headcount per day')).toBeInTheDocument();
    expect(screen.getAllByText('Total').length).toBeGreaterThan(0);
    expect(screen.getByText('2 rows')).toBeInTheDocument();
  });

  it('shows the not-found page for an unknown report', async () => {
    open('/reports/nonsense');
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });

  it('is closed to a user without the permission of that report', async () => {
    permissions = [reportsPermissions.stockRead];
    open('/reports/labour');
    await waitFor(() => expect(screen.queryByText('Labour')).not.toBeInTheDocument());
    expect(reportCalls()).toHaveLength(0);
  });

  it('shows the API message when the report fails', async () => {
    handler = (url) =>
      url.startsWith('/reports/stock')
        ? { status: 400, body: { error: { code: 'export_too_large', message: 'x' } } }
        : undefined;
    open('/reports/stock');
    expect(
      await screen.findByText('This export is too large. Narrow the filters and try again.'),
    ).toBeInTheDocument();
  });

  it('sends the project filter on apply and clears it on reset', async () => {
    open('/reports/project-cost');
    await screen.findAllByText('P-001');
    await choose('Project', 'P-001 Tower');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastReport()).toContain(`projectId=${PROJECT}`));
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(lastReport()).not.toContain('projectId'));
  });

  it('sends the filters that fit the report: ownership and below-reorder for stock', async () => {
    open('/reports/stock');
    await screen.findByText('Reorder level', {}, { timeout: 100 }).catch(() => undefined);
    await choose('Ownership', 'Client');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Below reorder level only' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastReport()).toContain('ownership=client'));
    expect(lastReport()).toContain('belowReorderOnly=true');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Below reorder level only' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastReport()).not.toContain('belowReorderOnly'));
  });

  it('sends the period and the overdue flag', async () => {
    open('/reports/pipeline');
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Overdue only' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastReport()).toContain('from=2026-10-01'));
    expect(lastReport()).toContain('to=2026-10-31');
    expect(lastReport()).toContain('overdueOnly=true');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastReport()).not.toContain('from='));
  });

  it('sorts on the server when a column header is clicked, ascending then descending', async () => {
    open('/reports/project-cost');
    await screen.findAllByText('P-001');
    await userEvent.click(screen.getByText('Budget'));
    await waitFor(() => expect(lastReport()).toContain('sort=budget&direction=asc'));
    await userEvent.click(screen.getByText('Budget'));
    await waitFor(() => expect(lastReport()).toContain('direction=desc'));
    await userEvent.click(screen.getByText('Budget'));
    await waitFor(() => expect(lastReport()).not.toContain('sort='));
  });

  it('asks the server for the next page', async () => {
    handler = (url) =>
      url.startsWith('/reports/project-cost')
        ? { body: { ...projectCost, total: 120 } }
        : url.startsWith('/reports/saved-filters')
          ? { body: { items: [] } }
          : undefined;
    open('/reports/project-cost');
    await screen.findAllByText('P-001');
    await userEvent.click(screen.getByTitle('2'));
    await waitFor(() => expect(lastReport()).toContain('offset=50'));
    expect(lastReport()).toContain('limit=50');
  });

  it('exports with the active filters and without paging', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    open('/reports/project-cost');
    await screen.findAllByText('P-001');
    await userEvent.click(screen.getByRole('button', { name: 'Export Excel' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(lastReport()).toContain('format=xlsx');
    expect(lastReport()).not.toContain('limit=');
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(lastReport()).toContain('format=csv'));
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it('shows the refusal message when an export is too large', async () => {
    handler = (url) =>
      url.includes('format=csv')
        ? { status: 422, body: { error: { code: 'export_too_large', message: 'big' } } }
        : undefined;
    open('/reports/labour');
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
    expect(
      await screen.findByText('This export is too large. Narrow the filters and try again.'),
    ).toBeInTheDocument();
  });

  it('falls back to a general message for an unexpected export failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/me')
          ? Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(profileOf(permissions)),
            })
          : url.includes('format=')
            ? Promise.reject(new Error('offline'))
            : Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(url.includes('saved') ? page([]) : emptyReport),
              }),
      ),
    );
    open('/reports/labour');
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('saved filters', () => {
  it('applies a saved filter', async () => {
    open('/reports/project-cost');
    await userEvent.click(await screen.findByRole('button', { name: 'Apply Main project' }));
    await waitFor(() => expect(lastReport()).toContain(`projectId=${PROJECT}`));
  });

  it('saves the current filters under a name', async () => {
    open('/reports/project-cost');
    await screen.findAllByText('P-001');
    const save = screen.getByRole('button', { name: 'Save filters' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Name for these filters'), 'Weekly');
    await userEvent.click(save);
    expect(await screen.findByText('The filters were saved.')).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/reports/saved-filters');
  });

  it('shows the message when saving fails', async () => {
    handler = (url, init) =>
      init.method === 'POST'
        ? { status: 409, body: { error: { code: 'saved_filter_exists', message: 'x' } } }
        : url.startsWith('/reports/saved-filters')
          ? { body: { items: [] } }
          : url.startsWith('/reports/')
            ? { body: projectCost }
            : undefined;
    open('/reports/project-cost');
    await userEvent.type(await screen.findByLabelText('Name for these filters'), 'Weekly');
    await userEvent.click(screen.getByRole('button', { name: 'Save filters' }));
    expect(
      await screen.findByText('You already have a saved filter with this name.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No saved filters yet.')).toBeInTheDocument();
  });

  it('removes a saved filter with its version', async () => {
    open('/reports/project-cost');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Main project' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/s1?version=2'))).toBe(
        true,
      ),
    );
  });

  it('shows the message when removing fails', async () => {
    handler = (url, init) =>
      init.method === 'DELETE'
        ? { status: 409, body: { error: { code: 'version_conflict', message: 'x' } } }
        : url.startsWith('/reports/saved-filters')
          ? { body: { items: [savedFilter] } }
          : url.startsWith('/reports/')
            ? { body: projectCost }
            : undefined;
    open('/reports/project-cost');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Main project' }));
    expect(
      await screen.findByText('Someone else changed this record. Reload and try again.'),
    ).toBeInTheDocument();
  });
});
