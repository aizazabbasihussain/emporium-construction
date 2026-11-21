import { formatAmount, formatDateTimeUtc, profitabilityPermissions } from '@emporium/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: unknown }[] = [];

const P1 = '018f0000-0000-7000-8000-0000000000a1';
const P2 = '018f0000-0000-7000-8000-0000000000a2';

const portfolio = {
  asOf: '2026-10-25',
  items: [
    {
      projectId: P1,
      code: 'P-001',
      name: 'Tower',
      status: 'active',
      contractValue: '1100000.00',
      billedPercent: '72.73',
      collectedPercent: '45.45',
      costPercentOfBudget: '66.67',
      expectedMargin: '200000.00',
      expectedMarginPercent: '18.18',
      cashPosition: '-1500.00',
      alerts: ['margin_below_floor', 'overspend'],
    },
    {
      projectId: P2,
      code: 'P-002',
      name: 'Annex',
      status: 'planning',
      contractValue: '0.00',
      billedPercent: null,
      collectedPercent: null,
      costPercentOfBudget: null,
      expectedMargin: '0.00',
      expectedMarginPercent: null,
      cashPosition: '210000.00',
      alerts: [],
    },
  ],
};

const financials = {
  projectId: P1,
  code: 'P-001',
  name: 'Tower',
  status: 'active',
  asOf: '2026-10-25',
  contractValue: '1100000.00',
  billedBase: '800000.00',
  billedTax: '144000.00',
  billedGross: '944000.00',
  billedPercent: '72.73',
  collectedGross: '590000.00',
  collectedBase: '500000.00',
  withheldTax: '20000.00',
  collectedPercent: '45.45',
  outstandingReceivable: '354000.00',
  committed: '100000.00',
  approved: '200000.00',
  posted: '300000.00',
  costToDate: '600000.00',
  budget: '900000.00',
  costPercentOfBudget: '66.67',
  costToComplete: '300000.00',
  costToCompleteSource: 'budget',
  expectedMargin: '200000.00',
  expectedMarginPercent: '18.18',
  currentMargin: '300000.00',
  currentMarginPercent: '37.50',
  paidOutVendors: '250000.00',
  paidOutWages: '120000.00',
  paidOutExpenses: '10000.00',
  paidOut: '380000.00',
  cashPosition: '210000.00',
  forecast: null,
  thresholds: {
    id: 't1',
    scope: 'company',
    projectId: null,
    marginFloorPercent: '25.0000',
    overspendPercent: '50.0000',
    receivableAgeDays: 30,
    active: true,
    version: 1,
  },
  alerts: ['margin_below_floor'],
  oldestDueDate: '2026-10-31',
};

const alertRows = [
  {
    id: 'a1',
    projectId: P1,
    projectCode: 'P-001',
    projectName: 'Tower',
    alertCode: 'overspend',
    raisedAt: '2026-10-25T10:00:00Z',
    clearedAt: null,
  },
  {
    id: 'a2',
    projectId: P1,
    projectCode: 'P-001',
    projectName: 'Tower',
    alertCode: 'margin_below_floor',
    raisedAt: '2026-10-20T10:00:00Z',
    clearedAt: '2026-10-24T10:00:00Z',
  },
];

const threshold = {
  id: 't1',
  scope: 'company',
  projectId: null,
  marginFloorPercent: '25.0000',
  overspendPercent: '50.0000',
  receivableAgeDays: 30,
  active: true,
  version: 3,
};

let thresholdRows: unknown[];
let createdUrl: () => string;

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  thresholdRows = [];
  handler = (url, init) => {
    if (url.startsWith('/profitability/projects/') && url.endsWith('/forecast')) {
      return {
        body: {
          id: 'f1',
          projectId: P1,
          costToComplete: '50000.00',
          note: '',
          forecastDate: '2026-10-25',
          setBy: 'u',
        },
      };
    }
    if (url.startsWith(`/profitability/projects/${P1}`)) return { body: financials };
    if (url.startsWith('/profitability/projects')) return { body: portfolio };
    if (url.startsWith('/profitability/alerts')) return { body: alertRows };
    if (url.startsWith('/profitability/thresholds') && init.method === 'POST') {
      return { status: 201, body: threshold };
    }
    if (url.startsWith('/profitability/thresholds') && init.method === 'PUT') {
      return { body: threshold };
    }
    if (url.startsWith('/profitability/thresholds') && init.method === 'DELETE') {
      return { body: { id: 't1' } };
    }
    if (url.startsWith('/profitability/thresholds')) return { body: thresholdRows };
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
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const { status = 200, body } = handler(url, init) ?? { body: [] };
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
        blob: () => Promise.resolve(new Blob(['x'])),
      });
    }),
  );
  createdUrl = vi.fn(() => 'blob:x');
  URL.createObjectURL = createdUrl;
  URL.revokeObjectURL = vi.fn();
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

const lastCall = (prefix: string, method?: string) =>
  [...calls]
    .reverse()
    .find(
      (call) => call.url.startsWith(prefix) && (method === undefined || call.method === method),
    );

describe('portfolio page (BR-5)', () => {
  it('shows every project with its figures, a flagged negative cash position and its alerts', async () => {
    open('/profitability');
    expect(await screen.findByText('P-001 Tower')).toBeInTheDocument();
    expect(screen.getByText('P-002 Annex')).toBeInTheDocument();
    expect(screen.getByText('72.73%')).toBeInTheDocument();
    expect(screen.getByText('66.67%')).toBeInTheDocument();
    expect(screen.getByText(/18\.18%/)).toBeInTheDocument();
    expect(screen.getByText('Expected margin is below the floor')).toBeInTheDocument();
    expect(screen.getByText('Cost used is above the overspend limit')).toBeInTheDocument();
    // A project with nothing to divide by shows "Not available", not a number or an error.
    expect(screen.getAllByText('Not available').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'P-001 Tower' })).toHaveAttribute(
      'href',
      `/profitability/projects/${P1}`,
    );
  });

  it('asks for another date and status, and exports the same view', async () => {
    open('/profitability');
    await screen.findByText('P-001 Tower');
    const date = screen.getByLabelText('As of');
    fireEvent.change(date, { target: { value: '2026-10-07' } });
    fireEvent.blur(date);
    await waitFor(() =>
      expect(lastCall('/profitability/projects')?.url).toContain('asOf=2026-10-07'),
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    await userEvent.click(await screen.findByTitle('active'));
    await waitFor(() =>
      expect(lastCall('/profitability/projects')?.url).toContain('status=active'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(lastCall('/profitability/projects?')?.url).toContain('format=csv'));
    expect(lastCall('/profitability/projects?')?.url).toContain('asOf=2026-10-07');
    await userEvent.click(screen.getByRole('button', { name: 'Export Excel' }));
    await waitFor(() => expect(lastCall('/profitability/projects?')?.url).toContain('format=xlsx'));
    expect(createdUrl).toHaveBeenCalled();
  });

  it('shows an empty list, the API message on failure, and the forbidden page without permission', async () => {
    handler = (url) =>
      url.startsWith('/profitability/projects')
        ? { body: { asOf: '2026-10-25', items: [] } }
        : undefined;
    const first = open('/profitability');
    expect(await screen.findByText('There are no projects to show.')).toBeInTheDocument();
    first.unmount();

    handler = () => ({
      status: 400,
      body: { error: { code: 'invalid_date', message: 'bad date' } },
    });
    const second = open('/profitability');
    expect(await screen.findByText('bad date')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(screen.getAllByText('bad date').length).toBeGreaterThan(1));
    second.unmount();

    calls.length = 0;
    permissions = [];
    open('/profitability');
    expect(await screen.findByText(/not allowed|forbidden|permission/i)).toBeInTheDocument();
    expect(calls.filter((call) => call.url.startsWith('/profitability'))).toHaveLength(0);
  });
});

describe('project page', () => {
  it('shows contract, billing, cost by status, margins, cash and the alerts that hold', async () => {
    open(`/profitability/projects/${P1}`);
    expect(await screen.findByText('P-001 Tower')).toBeInTheDocument();
    expect(screen.getByText('Contract value (with approved variations)')).toBeInTheDocument();
    expect(screen.getByText(formatAmount('1100000.00'))).toBeInTheDocument();
    expect(screen.getByText('Cost committed')).toBeInTheDocument();
    expect(screen.getByText('Cost approved')).toBeInTheDocument();
    expect(screen.getByText('Cost posted')).toBeInTheDocument();
    expect(screen.getByText('Cost to complete (from the budget)')).toBeInTheDocument();
    expect(screen.getByText(`${formatAmount('200000.00')} (18.18%)`)).toBeInTheDocument();
    expect(screen.getByText(`${formatAmount('300000.00')} (37.50%)`)).toBeInTheDocument();
    expect(screen.getByText(formatAmount('210000.00'))).toBeInTheDocument();
    expect(screen.getByText('31/10/2026')).toBeInTheDocument();
    expect(screen.getByText('Expected margin is below the floor')).toBeInTheDocument();
    expect(screen.getByText('No manual forecast; the unused budget is used.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to all projects' })).toBeInTheDocument();
  });

  it('says so when no thresholds are set, when no alert holds and when the company funded the project', async () => {
    handler = (url) =>
      url.startsWith(`/profitability/projects/${P1}`)
        ? {
            body: {
              ...financials,
              thresholds: null,
              alerts: [],
              oldestDueDate: null,
              cashPosition: '-1500.00',
              billedPercent: null,
              forecast: {
                id: 'f',
                projectId: P1,
                costToComplete: '5000.00',
                note: '',
                forecastDate: '2026-10-20',
                setBy: 'u',
              },
              costToCompleteSource: 'forecast',
            },
          }
        : undefined;
    open(`/profitability/projects/${P1}`);
    expect(
      await screen.findByText('No alert thresholds are set, so no alerts are raised.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/The company has funded this project/)).toBeInTheDocument();
    expect(screen.getByText('Cost to complete (manual forecast)')).toBeInTheDocument();
    expect(
      screen.getByText(`Latest forecast: PKR ${formatAmount('5000.00')} on 20/10/2026`),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0);
  });

  it('shows "no alert holds" when thresholds exist and nothing is breached', async () => {
    handler = (url) =>
      url.startsWith(`/profitability/projects/${P1}`)
        ? { body: { ...financials, alerts: [] } }
        : undefined;
    open(`/profitability/projects/${P1}`);
    expect(await screen.findByText('No alert holds on this date.')).toBeInTheDocument();
  });

  it('asks for the figures of another date and exports the project', async () => {
    open(`/profitability/projects/${P1}`);
    await screen.findByText('P-001 Tower');
    const date = screen.getByLabelText('As of');
    fireEvent.change(date, { target: { value: '2026-10-09' } });
    fireEvent.blur(date);
    await waitFor(() =>
      expect(lastCall(`/profitability/projects/${P1}`)?.url).toContain('asOf=2026-10-09'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() =>
      expect(lastCall(`/profitability/projects/${P1}?`)?.url).toContain('format=csv'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Export Excel' }));
    await waitFor(() =>
      expect(lastCall(`/profitability/projects/${P1}?`)?.url).toContain('format=xlsx'),
    );
  });

  it('checks the forecast amount before sending it, then saves it', async () => {
    open(`/profitability/projects/${P1}`);
    await screen.findByText('P-001 Tower');
    const save = screen.getByRole('button', { name: 'Save forecast' });
    await userEvent.click(save);
    expect(await screen.findByText('Enter an amount of zero or more.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    for (const bad of ['-5', '1.234', 'abc']) {
      await userEvent.clear(screen.getByLabelText('Cost to complete (PKR)'));
      await userEvent.type(screen.getByLabelText('Cost to complete (PKR)'), bad);
      await userEvent.click(save);
      expect(screen.getByText('Enter an amount of zero or more.')).toBeInTheDocument();
    }
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    await userEvent.clear(screen.getByLabelText('Cost to complete (PKR)'));
    await userEvent.type(screen.getByLabelText('Cost to complete (PKR)'), '50000');
    await userEvent.type(screen.getByLabelText('Note'), ' after the roof ');
    fireEvent.change(screen.getByLabelText('Forecast date'), { target: { value: '2026-10-24' } });
    await userEvent.click(save);
    expect(await screen.findByText('The forecast was saved.')).toBeInTheDocument();
    const put = lastCall(`/profitability/projects/${P1}/forecast`);
    expect(put).toMatchObject({
      method: 'PUT',
      body: { costToComplete: '50000', note: 'after the roof', forecastDate: '2026-10-24' },
    });
    expect(screen.queryByText('Enter an amount of zero or more.')).not.toBeInTheDocument();
  });

  it('sends only the amount when no note or date is given', async () => {
    open(`/profitability/projects/${P1}`);
    await screen.findByText('P-001 Tower');
    await userEvent.type(screen.getByLabelText('Cost to complete (PKR)'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save forecast' }));
    await screen.findByText('The forecast was saved.');
    expect(lastCall(`/profitability/projects/${P1}/forecast`)?.body).toEqual({
      costToComplete: '0',
    });
  });

  it('shows the API message when saving fails', async () => {
    handler = (url, init) =>
      init.method === 'PUT'
        ? { status: 400, body: { error: { code: 'invalid_amount', message: 'x' } } }
        : url.startsWith(`/profitability/projects/${P1}`)
          ? { body: financials }
          : undefined;
    open(`/profitability/projects/${P1}`);
    await screen.findByText('P-001 Tower');
    await userEvent.type(screen.getByLabelText('Cost to complete (PKR)'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save forecast' }));
    expect(
      await screen.findByText('The cost to complete must be zero or more.'),
    ).toBeInTheDocument();
  });

  it('shows the forecast form only to those who may set a forecast', async () => {
    permissions = [profitabilityPermissions.read];
    open(`/profitability/projects/${P1}`);
    await screen.findByText('P-001 Tower');
    expect(screen.queryByRole('button', { name: 'Save forecast' })).not.toBeInTheDocument();
  });

  it('shows the not-found message for a hidden or missing project', async () => {
    handler = () => ({
      status: 404,
      body: { error: { code: 'project_not_found', message: 'Not found' } },
    });
    open(`/profitability/projects/${P1}`);
    expect(await screen.findByText('The project was not found.')).toBeInTheDocument();
  });

  it('is closed without the read permission', async () => {
    permissions = [profitabilityPermissions.forecastSet];
    open(`/profitability/projects/${P1}`);
    expect(await screen.findByText(/not allowed|forbidden|permission/i)).toBeInTheDocument();
  });
});

describe('alerts and thresholds page', () => {
  it('lists open and cleared alerts and narrows to the open ones', async () => {
    open('/profitability/alerts');
    expect(await screen.findAllByText('P-001 Tower')).toHaveLength(2);
    expect(screen.getAllByText('Cost used is above the overspend limit').length).toBeGreaterThan(0);
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText(formatDateTimeUtc('2026-10-24T10:00:00Z'))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Open alerts only' }));
    await waitFor(() => expect(lastCall('/profitability/alerts')?.url).toContain('onlyOpen=true'));
  });

  it('shows an empty list and an API failure', async () => {
    handler = (url) => (url.startsWith('/profitability/alerts') ? { body: [] } : undefined);
    const first = open('/profitability/alerts');
    expect(await screen.findByText('There are no alerts.')).toBeInTheDocument();
    first.unmount();
    handler = (url) =>
      url.startsWith('/profitability/alerts')
        ? { status: 403, body: { error: { code: 'forbidden', message: 'no' } } }
        : undefined;
    open('/profitability/alerts');
    expect(await screen.findByText('You are not allowed to do this.')).toBeInTheDocument();
  });

  it('lets management add company thresholds after checking the numbers', async () => {
    open('/profitability/alerts');
    expect(await screen.findByText('No thresholds are set.')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save thresholds' });
    await userEvent.click(save);
    expect(await screen.findByText('The thresholds are not valid.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Margin floor %'), '25');
    await userEvent.type(screen.getByLabelText('Overspend limit %'), '50');
    await userEvent.type(screen.getByLabelText('Receivable age limit (days)'), '1.5');
    await userEvent.click(save);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await userEvent.clear(screen.getByLabelText('Receivable age limit (days)'));
    await userEvent.type(screen.getByLabelText('Receivable age limit (days)'), '30');
    await userEvent.click(save);
    expect(await screen.findByText('The thresholds were saved.')).toBeInTheDocument();
    expect(lastCall('/profitability/thresholds', 'POST')).toMatchObject({
      method: 'POST',
      body: {
        scope: 'company',
        marginFloorPercent: '25',
        overspendPercent: '50',
        receivableAgeDays: 30,
        active: true,
      },
    });
  });

  it('lets management change and remove the company thresholds', async () => {
    thresholdRows = [threshold, { ...threshold, id: 't2', scope: 'project', projectId: P1 }];
    open('/profitability/alerts');
    const marginField = await screen.findByDisplayValue('25.0000');
    expect(screen.getByText(/Scope: 1/)).toBeInTheDocument();
    await userEvent.clear(marginField);
    await userEvent.type(marginField, '30');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save thresholds' }));
    await screen.findByText('The thresholds were saved.');
    expect(lastCall('/profitability/thresholds/t1', 'PUT')).toMatchObject({
      method: 'PUT',
      body: {
        marginFloorPercent: '30',
        overspendPercent: '50.0000',
        receivableAgeDays: 30,
        active: false,
        version: 3,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(lastCall('/profitability/thresholds/t1?', 'DELETE')).toBeDefined());
    expect(lastCall('/profitability/thresholds/t1?', 'DELETE')?.url).toContain('version=3');
  });

  it('shows the API message when saving the thresholds fails', async () => {
    thresholdRows = [threshold];
    handler = (url, init) => {
      if (url.startsWith('/profitability/thresholds') && init.method === 'PUT') {
        return { status: 409, body: { error: { code: 'version_conflict', message: 'x' } } };
      }
      if (url.startsWith('/profitability/thresholds') && init.method === 'DELETE') {
        return { status: 409, body: { error: { code: 'version_conflict', message: 'x' } } };
      }
      if (url.startsWith('/profitability/thresholds')) return { body: thresholdRows };
      if (url.startsWith('/profitability/alerts')) return { body: alertRows };
      return undefined;
    };
    open('/profitability/alerts');
    await screen.findByDisplayValue('25.0000');
    await userEvent.click(screen.getByRole('button', { name: 'Save thresholds' }));
    expect(
      await screen.findByText('Someone else changed this record. Reload and try again.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(
        screen.getAllByText('Someone else changed this record. Reload and try again.').length,
      ).toBeGreaterThan(0),
    );
  });

  it('shows the thresholds read-only to those who may not manage them', async () => {
    permissions = [profitabilityPermissions.read];
    thresholdRows = [threshold];
    open('/profitability/alerts');
    expect(await screen.findByText('25.0000% / 50.0000% / 30')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save thresholds' })).not.toBeInTheDocument();
    expect(within(document.body).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('shows no threshold form to a reader when there are none', async () => {
    permissions = [profitabilityPermissions.read];
    open('/profitability/alerts');
    expect(await screen.findByText('No thresholds are set.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save thresholds' })).not.toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('lists the profitability pages for a reader', async () => {
    open('/');
    expect(await screen.findAllByText('Project profitability')).not.toHaveLength(0);
    expect(screen.getAllByText('Profitability alerts').length).toBeGreaterThan(0);
  });
});
