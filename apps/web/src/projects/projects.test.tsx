import { projectsPermissions } from '@emporium/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { Budget, CostSummary, ProjectDetail, Task } from './api';
import { BudgetEditor, budgetProblem } from './BudgetEditor';

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
  siteAddress: 'Plot 5',
  status: 'planning',
  startDate: null,
  plannedEndDate: null,
  actualEndDate: null,
  originalContractValue: '2000000.00',
  quotationId: null,
  estimateId: null,
  projectManagerId: null,
  progressPercent: '50.00',
  version: 4,
  supervisors: [],
  ...over,
});

const budget: Budget = {
  projectVersion: 4,
  lines: [
    { id: 'b1', costCodeId: 'cc1', description: '', budgetAmount: '1000.00', source: 'estimate' },
    {
      id: 'b2',
      costCodeId: 'cc2',
      description: 'VAR-1',
      budgetAmount: '75.00',
      source: 'variation',
    },
  ],
};

const summary: CostSummary = {
  lines: [
    {
      costCodeId: 'cc1',
      committed: '400.00',
      approved: '0.00',
      posted: '700.00',
      budget: '1000.00',
      variance: '-100.00',
      flag: 'overspent',
    },
  ],
  totals: { committed: '400.00', approved: '0.00', posted: '700.00' },
  budget: '1000.00',
  variance: '-100.00',
  flag: 'overspent',
};

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  projectId: 'p1',
  name: 'Excavation',
  assignedToUser: null,
  startDate: null,
  dueDate: null,
  status: 'todo',
  percentComplete: 0,
  version: 2,
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = (url) => {
    if (url.startsWith('/projects/p1/summary')) return { body: summary };
    if (url.startsWith('/projects/p1/budget')) return { body: budget };
    if (url.startsWith('/projects/p1/tasks')) return { body: [task()] };
    if (url.startsWith('/projects/p1/cost-entries')) {
      return {
        body: page([
          {
            id: 'e1',
            costCodeId: 'cc1',
            amount: '400.00',
            status: 'committed',
            sourceModule: 'procurement',
            sourceDocType: 'purchase_order',
            entryDate: '2026-10-25',
            description: 'Bricks',
          },
        ]),
      };
    }
    if (url.startsWith('/projects/p1')) return { body: project() };
    if (url.startsWith('/projects?')) {
      return {
        body: page([
          project(),
          { ...project(), id: 'p2', code: 'PRJ-0002', name: 'Tower', status: 'active' },
        ]),
      };
    }
    if (url.startsWith('/master/cost-codes')) {
      return {
        body: page([
          { id: 'cc1', code: '100', name: 'Materials' },
          { id: 'cc2', code: '200', name: 'Labour' },
        ]),
      };
    }
    if (url.startsWith('/master/parties'))
      return { body: page([{ id: 'c1', name: 'Acme Client' }]) };
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

const options = [
  { value: 'cc1', label: '100 Materials' },
  { value: 'cc2', label: '200 Labour' },
];

describe('budget editor (spec T-8)', () => {
  it('reports a line without a cost code or amount', () => {
    expect(budgetProblem([])).toBeNull();
    expect(budgetProblem([{ costCodeId: '', description: '', budgetAmount: '5' }])).toBe(
      'incomplete',
    );
    expect(budgetProblem([{ costCodeId: 'cc1', description: '', budgetAmount: ' ' }])).toBe(
      'incomplete',
    );
    expect(budgetProblem([{ costCodeId: 'cc1', description: '', budgetAmount: '5' }])).toBeNull();
  });

  it('edits, adds and removes lines and saves the editable ones as text', async () => {
    const onSave = vi.fn();
    render(
      withQuery(
        <BudgetEditor lines={budget.lines} costCodeOptions={options} canEdit onSave={onSave} />,
      ),
    );
    expect(screen.getByText(/VAR-1/)).toBeInTheDocument();
    expect(screen.getByLabelText('Amount 1')).toHaveValue('1000.00');
    expect(screen.queryByLabelText('Amount 2')).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Amount 1'));
    await userEvent.type(screen.getByLabelText('Amount 1'), '1500.5');
    await userEvent.type(screen.getByLabelText('Description 1'), 'Bricks');
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(
      screen.getByText('Choose a cost code and enter an amount for every line.'),
    ).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Remove 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(onSave).toHaveBeenCalledWith([
      { costCodeId: 'cc1', description: 'Bricks', budgetAmount: '1500.5' },
    ]);
  });

  it('chooses a cost code for a new line', async () => {
    const onSave = vi.fn();
    render(
      withQuery(<BudgetEditor lines={[]} costCodeOptions={options} canEdit onSave={onSave} />),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await userEvent.type(screen.getByLabelText('Amount 1'), '10');
    await userEvent.click(screen.getByLabelText('Cost code 1'));
    await userEvent.click(await screen.findByTitle('200 Labour'));
    await userEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    expect(onSave).toHaveBeenCalledWith([
      { costCodeId: 'cc2', description: '', budgetAmount: '10' },
    ]);
  });

  it('is read-only without the permission and shows a message from the API', () => {
    render(
      withQuery(
        <BudgetEditor
          lines={budget.lines}
          costCodeOptions={options}
          canEdit={false}
          error="Could not save"
          onSave={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText('Could not save')).toBeVisible();
    expect(screen.getByLabelText('Amount 1')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save budget' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument();
  });
});

describe('project list', () => {
  it('lists projects and filters them by text and status', async () => {
    open('/projects');
    expect(await screen.findByRole('link', { name: 'PRJ-0001' })).toBeInTheDocument();
    expect(screen.getAllByText('50.00%').length).toBeGreaterThan(0);
    await userEvent.type(screen.getByRole('searchbox'), 'wall{enter}');
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=wall'))).toBe(true));
    await userEvent.click(screen.getByLabelText('Status'));
    await userEvent.click(await screen.findByTitle('Active'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=active'))).toBe(true));
  });

  it('hides the new project button without the create permission', async () => {
    permissions = [projectsPermissions.read];
    open('/projects');
    await screen.findByRole('link', { name: 'PRJ-0001' });
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('creates a manual project and opens its dashboard', async () => {
    handler = ((previous) => (url: string, init: RequestInit) => {
      if (url === '/projects' && init.method === 'POST') return { status: 201, body: project() };
      return previous(url, init);
    })(handler);
    open('/projects');
    await userEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(
      within(dialog).getByText('Enter a name, a client and a contract value.'),
    ).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Name'), ' Boundary wall ');
    await userEvent.click(within(dialog).getByLabelText('Client'));
    await userEvent.click(await screen.findByTitle('Acme Client'));
    await userEvent.type(within(dialog).getByLabelText('Contract value'), '2000000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('heading', { name: /PRJ-0001 Boundary wall/ })).toBeVisible();
    expect(calls.find((c) => c.method === 'POST' && c.url === '/projects')?.body).toEqual({
      name: 'Boundary wall',
      partyId: 'c1',
      sector: 'private',
      originalContractValue: '2000000',
    });
  });

  it('shows the explanation when the API refuses a government project', async () => {
    handler = ((previous) => (url: string, init: RequestInit) => {
      if (url === '/projects' && init.method === 'POST') {
        return {
          status: 422,
          body: { error: { code: 'government_data_not_allowed', message: 'no' } },
        };
      }
      return previous(url, init);
    })(handler);
    open('/projects');
    await userEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Ministry block');
    await userEvent.click(within(dialog).getByLabelText('Client'));
    await userEvent.click(await screen.findByTitle('Acme Client'));
    await userEvent.type(within(dialog).getByLabelText('Contract value'), '5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(
      await screen.findByText('Government projects cannot be created in this environment.'),
    ).toBeInTheDocument();
  });
});

describe('project dashboard', () => {
  it('shows contract value, progress and the budget against cost with its total', async () => {
    open('/projects/p1');
    expect(await screen.findByRole('heading', { name: /PRJ-0001 Boundary wall/ })).toBeVisible();
    expect(screen.getByText('50.00%')).toBeVisible();
    expect(await screen.findByText('100 Materials')).toBeVisible();
    expect(screen.getByText('Over budget')).toBeVisible();
    expect(screen.getAllByText('400.00').length).toBeGreaterThan(0);
  });

  it('changes the status with the version it loaded', async () => {
    open('/projects/p1');
    await screen.findByRole('heading', { name: /PRJ-0001/ });
    await userEvent.click(screen.getByLabelText('Change status'));
    await userEvent.click(await screen.findByTitle('Active'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/projects/p1/status')?.body).toEqual({
        status: 'active',
        version: 4,
      }),
    );
  });

  it('shows the API reason when a project cannot be closed', async () => {
    handler = ((previous) => (url: string, init: RequestInit) => {
      if (url === '/projects/p1/status') {
        return { status: 422, body: { error: { code: 'project_has_open_costs', message: 'x' } } };
      }
      return previous(url, init);
    })(handler);
    open('/projects/p1');
    await screen.findByRole('heading', { name: /PRJ-0001/ });
    await userEvent.click(screen.getByLabelText('Change status'));
    await userEvent.click(await screen.findByTitle('Closed'));
    expect(await screen.findByText(/still has committed or unposted approved costs/)).toBeVisible();
  });

  it('saves the budget under the project version it loaded', async () => {
    open('/projects/p1');
    await screen.findByRole('heading', { name: /PRJ-0001/ });
    await userEvent.click(screen.getByRole('tab', { name: 'Budget' }));
    const amount = await screen.findByLabelText('Amount 1');
    await userEvent.clear(amount);
    await userEvent.type(amount, '1200');
    await userEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        version: 4,
        lines: [{ costCodeId: 'cc1', description: '', budgetAmount: '1200' }],
      }),
    );
  });

  it('adds a task and moves one to done', async () => {
    open('/projects/p1');
    await screen.findByRole('heading', { name: /PRJ-0001/ });
    await userEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect(await screen.findByText('Excavation')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Task name'), ' Footings ');
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url === '/projects/p1/tasks')?.body,
      ).toEqual({ name: 'Footings' }),
    );
    await userEvent.click(screen.getByLabelText('Status Excavation'));
    await userEvent.click(await screen.findByTitle('Done'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        version: 2,
        status: 'done',
      }),
    );
  });

  it('drills down to the cost entries', async () => {
    open('/projects/p1');
    await screen.findByRole('heading', { name: /PRJ-0001/ });
    await userEvent.click(screen.getByRole('tab', { name: 'Cost entries' }));
    expect(await screen.findByText('Bricks')).toBeVisible();
    expect(screen.getByText('procurement / purchase_order')).toBeVisible();
    expect(screen.getByText('Committed', { selector: '.ant-tag' })).toBeVisible();
  });

  it('hides cost data and edit controls from a supervisor-like reader', async () => {
    permissions = [projectsPermissions.read];
    open('/projects/p1');
    await screen.findByRole('heading', { name: /PRJ-0001/ });
    expect(screen.queryByLabelText('Change status')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/summary'))).toBe(false);
    await userEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Budget' }));
    expect(await screen.findByLabelText('Amount 1')).toBeDisabled();
  });

  it('reports a load failure', async () => {
    handler = ((previous) => (url: string, init: RequestInit) => {
      if (url === '/projects/p1')
        return { status: 404, body: { error: { code: 'project_not_found' } } };
      return previous(url, init);
    })(handler);
    open('/projects/p1');
    expect(await screen.findByText('Could not load data')).toBeVisible();
  });
});
