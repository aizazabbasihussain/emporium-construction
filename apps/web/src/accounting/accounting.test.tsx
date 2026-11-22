import { accountingPermissions } from '@emporium/shared';
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

const exportList = [
  {
    code: 'sales_register',
    title: 'Sales register',
    schemaVersion: 1,
    columns: [
      { key: 'date', type: 'date' },
      { key: 'base', type: 'money' },
      { key: 'account_code', type: 'text' },
    ],
  },
  { code: 'aging', title: 'Aging', schemaVersion: 1, columns: [{ key: 'side', type: 'text' }] },
  {
    code: 'withholding_report',
    title: 'Withholding report',
    schemaVersion: 1,
    columns: [{ key: 'amount', type: 'money' }],
  },
];

const run = {
  id: 'run-1',
  exportCode: 'sales_register',
  schemaVersion: 1,
  filters: { from: '2026-10-01', to: '2026-10-31' },
  rowCount: 3,
  checksumSha256: 'abcdef0123456789'.repeat(4),
  fileId: 'file-xlsx',
  runBy: 'u1',
  runAt: '2026-10-25T10:00:00Z',
};

const accounts = [
  {
    code: '1210',
    name: 'Trade receivables (clients)',
    type: 'asset',
    parentCode: '1200',
    active: true,
    version: 1,
  },
  {
    code: '4100',
    name: 'Contract revenue, construction',
    type: 'income',
    parentCode: '4000',
    active: true,
    version: 1,
  },
  {
    code: '6900',
    name: 'Other overheads',
    type: 'expense',
    parentCode: '6000',
    active: false,
    version: 4,
  },
];

const untagged = {
  items: [
    {
      sourceDocType: 'invoice',
      sourceDocId: 'inv-1',
      lineRef: '',
      date: '2026-10-05',
      number: 'INV-2026-0001',
      party: 'Synthetic Client',
      amount: '108000.00',
      description: '',
      suggestedAccountCode: '4100',
    },
    {
      sourceDocType: 'bill',
      sourceDocId: 'bill-1',
      lineRef: '',
      date: '2026-10-06',
      number: 'BILL-2026-0001',
      party: 'Synthetic Vendor',
      amount: '54000.00',
      description: '',
      suggestedAccountCode: null,
    },
  ],
  total: 2,
  limit: 200,
  offset: 0,
  byType: { invoice: 1, bill: 1 },
};

const rule = {
  id: 'rule-1',
  sourceDocType: 'invoice',
  condition: { kind: 'advance' },
  debitAccountCode: '1210',
  creditAccountCode: '4100',
  effectiveFrom: '2026-07-01',
  active: true,
  version: 2,
};

let opened: string[];

beforeEach(() => {
  calls.length = 0;
  opened = [];
  permissions = allPermissions;
  handler = (url, init) => {
    const method = init.method ?? 'GET';
    if (url === '/exports') return { body: exportList };
    if (url.startsWith('/exports/runs')) return { body: { items: [run], total: 1 } };
    if (url.endsWith('/run') && method === 'POST') {
      return {
        status: 201,
        body: {
          run,
          untagged: 2,
          totals: { base: '140000.00' },
          files: { xlsx: 'file-xlsx', csv: 'file-csv' },
        },
      };
    }
    if (url.startsWith('/files/'))
      return { body: { url: `https://files.example/${url.split('/')[2]}`, expiresAt: 'x' } };
    if (url.startsWith('/accounting/untagged')) return { body: untagged };
    if (url === '/accounting/tags') return { body: [] };
    if (url.startsWith('/accounting/backfill/dry-run')) {
      return {
        body: {
          dryRun: true,
          considered: 10,
          alreadyTagged: 4,
          tagged: 5,
          unmatched: 1,
          sample: [
            { sourceDocType: 'invoice', sourceDocId: 'inv-1', lineRef: '', accountCode: '4100' },
          ],
        },
      };
    }
    if (url.startsWith('/accounting/backfill/commit')) {
      return {
        body: {
          dryRun: false,
          considered: 10,
          alreadyTagged: 4,
          tagged: 5,
          unmatched: 1,
          sample: [],
        },
      };
    }
    if (url.startsWith('/accounting/accounts') && method === 'PUT') {
      return { body: { ...accounts[2], active: true, version: 5 } };
    }
    if (url.startsWith('/accounting/accounts')) {
      return {
        body: url.includes('includeInactive=true') ? accounts : accounts.filter((a) => a.active),
      };
    }
    if (url === '/accounting/mapping-rules' && method === 'PUT') return { status: 201, body: rule };
    if (url === '/accounting/mapping-rules') return { body: [rule] };
    return undefined;
  };
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal('open', (url: string) => {
    opened.push(url);
    return null;
  });
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

/** Opens a select and picks an option; earlier dropdowns stay in the page, so the last match is the open one. */
const pick = async (name: string, title: string) => {
  await userEvent.click(screen.getByRole('combobox', { name }));
  const options = await screen.findAllByTitle(title);
  await userEvent.click(options[options.length - 1] as HTMLElement);
};

const lastCall = (prefix: string, method?: string) =>
  [...calls]
    .reverse()
    .find((c) => c.url.startsWith(prefix) && (method === undefined || c.method === method));

describe('exports hub (BR-3, BR-6, AC-1)', () => {
  it('shows the layout, runs an export for a period and offers both files with the warning count', async () => {
    open('/accounting/exports');
    expect(await screen.findByText(/Columns: date, base, account_code/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    await userEvent.click(screen.getByRole('button', { name: 'Run export' }));
    expect(await screen.findByText(/Lines without an account code: 2/)).toBeInTheDocument();
    expect(lastCall('/exports/sales_register/run', 'POST')?.body).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    const links = screen.getAllByRole('link', { name: 'Untagged documents' });
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const link of links) expect(link).toHaveAttribute('href', '/accounting/untagged');
    expect(screen.getByText(/base 140,000\.00/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() =>
      expect(opened).toEqual(['https://files.example/file-csv/url'.replace('/url', '')]),
    );
    // The result panel is above the history, so its button comes first.
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Download Excel' })[0] as HTMLElement,
    );
    await waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[1]).toBe('https://files.example/file-xlsx');
  });

  it('lists the earlier runs and downloads one', async () => {
    open('/accounting/exports');
    const row = (await screen.findByText('abcdef012345')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Sales register')).toBeInTheDocument();
    expect(within(row).getByText('2026-10-01 - 2026-10-31')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Download Excel' }));
    await waitFor(() => expect(opened).toEqual(['https://files.example/file-xlsx']));
  });

  it('shows the side filter for aging and the authority filter for the withholding report', async () => {
    open('/accounting/exports');
    await screen.findByText(/Columns:/);
    expect(screen.queryByLabelText('Tax authority')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Export' }));
    await userEvent.click(await screen.findByTitle('Aging'));
    await userEvent.click(await screen.findByRole('combobox', { name: 'Side' }));
    await userEvent.click(await screen.findByTitle('Payable'));
    await userEvent.click(screen.getByRole('button', { name: 'Run export' }));
    await waitFor(() =>
      expect(lastCall('/exports/aging/run', 'POST')?.body).toMatchObject({ side: 'payable' }),
    );

    await userEvent.click(screen.getByRole('combobox', { name: 'Export' }));
    await userEvent.click(await screen.findByTitle('Withholding report'));
    expect(screen.queryByRole('combobox', { name: 'Side' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Tax authority'), ' FBR ');
    await userEvent.click(screen.getByRole('button', { name: 'Run export' }));
    await waitFor(() =>
      expect(lastCall('/exports/withholding_report/run', 'POST')?.body).toMatchObject({
        authorityCode: 'FBR',
      }),
    );
  });

  it('says every line is tagged when none is missing, and shows the abort of a control-total mismatch', async () => {
    handler = (url, init) =>
      url === '/exports'
        ? { body: exportList }
        : url.startsWith('/exports/runs')
          ? { body: { items: [], total: 0 } }
          : url.endsWith('/run') && init.method === 'POST'
            ? {
                status: 201,
                body: {
                  run,
                  untagged: 0,
                  totals: {},
                  files: { xlsx: 'file-xlsx', csv: 'file-csv' },
                },
              }
            : undefined;
    open('/accounting/exports');
    expect(await screen.findByText('No export has been run yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run export' }));
    expect(await screen.findByText('Every line has an account code.')).toBeInTheDocument();

    handler = (url, init) =>
      url.endsWith('/run') && init.method === 'POST'
        ? {
            status: 422,
            body: {
              error: { code: 'control_total_mismatch', message: 'base exported 1, source 2' },
            },
          }
        : url === '/exports'
          ? { body: exportList }
          : { body: { items: [], total: 0 } };
    await userEvent.click(screen.getByRole('button', { name: 'Run export' }));
    expect(
      await screen.findByText('Nothing was produced. base exported 1, source 2'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Every line has an account code.')).not.toBeInTheDocument();
  });

  it('shows an unknown error as a load error and a failed link as an error', async () => {
    const normal = handler;
    handler = (url, init) =>
      url.startsWith('/files/')
        ? { status: 403, body: { error: { code: 'forbidden', message: 'No' } } }
        : normal(url, init);
    open('/accounting/exports');
    const row = (await screen.findByText('abcdef012345')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Download Excel' }));
    expect(await screen.findByText('No')).toBeInTheDocument();
  });

  it('hides the run button from a caller who may only read', async () => {
    permissions = [accountingPermissions.exportRead];
    open('/accounting/exports');
    await screen.findByText(/Columns:/);
    expect(screen.queryByRole('button', { name: 'Run export' })).not.toBeInTheDocument();
  });

  it('blocks a caller who holds an accounting permission but not one for exports', async () => {
    permissions = [accountingPermissions.tagManage];
    open('/accounting/exports');
    expect(
      await screen.findByText('You do not have permission to open this page.'),
    ).toBeInTheDocument();
  });
});

describe('untagged queue (BR-2, BR-9, AC-2)', () => {
  it('lists the lines with the suggestion, then tags the chosen ones with one account', async () => {
    open('/accounting/untagged');
    expect(await screen.findByText('INV-2026-0001')).toBeInTheDocument();
    expect(screen.getByText(/Invoice 1; Vendor bill 1/)).toBeInTheDocument();
    expect(screen.getByText('4100')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tag selected' })).toBeDisabled();
    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[1] as HTMLElement);
    await userEvent.click(checkboxes[2] as HTMLElement);
    expect(screen.getByText('Selected: 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    await userEvent.click(await screen.findByTitle('4100 Contract revenue, construction'));
    await userEvent.click(screen.getByRole('button', { name: 'Tag selected' }));
    expect(await screen.findByText('Tagged 2 lines.')).toBeInTheDocument();
    expect(lastCall('/accounting/tags', 'PUT')?.body).toEqual({
      targets: [
        { docType: 'invoice', docId: 'inv-1', lineRef: '' },
        { docType: 'bill', docId: 'bill-1', lineRef: '' },
      ],
      accountCode: '4100',
    });
    expect(screen.getByText('Selected: 0')).toBeInTheDocument();
  });

  it('filters by period and type', async () => {
    open('/accounting/untagged');
    await screen.findByText('INV-2026-0001');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    await userEvent.click(screen.getByRole('combobox', { name: 'Document type' }));
    await userEvent.click(await screen.findByTitle('Receipt'));
    await waitFor(() => {
      const url = lastCall('/accounting/untagged')?.url ?? '';
      expect(url).toContain('from=2026-10-01');
      expect(url).toContain('to=2026-10-31');
      expect(url).toContain('docType=receipt');
    });
  });

  it('shows an empty queue and an error from the tagging call', async () => {
    handler = (url) =>
      url.startsWith('/accounting/untagged')
        ? { body: { items: [], total: 0, limit: 200, offset: 0, byType: {} } }
        : undefined;
    const first = open('/accounting/untagged');
    expect(
      await screen.findByText('Every line in this period has an account code.'),
    ).toBeInTheDocument();
    first.unmount();

    handler = (url, init) =>
      url === '/accounting/tags' && init.method === 'PUT'
        ? { status: 400, body: { error: { code: 'inactive_account', message: 'off' } } }
        : url.startsWith('/accounting/untagged')
          ? { body: untagged }
          : url.startsWith('/accounting/accounts')
            ? { body: accounts.filter((a) => a.active) }
            : undefined;
    open('/accounting/untagged');
    await screen.findByText('INV-2026-0001');
    await userEvent.click(screen.getAllByRole('checkbox')[1] as HTMLElement);
    await userEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    await userEvent.click(await screen.findByTitle('1210 Trade receivables (clients)'));
    await userEvent.click(screen.getByRole('button', { name: 'Tag selected' }));
    expect(await screen.findByText('That account is switched off.')).toBeInTheDocument();
  });

  it('runs the backfill as a dry run first and commits only after it', async () => {
    open('/accounting/untagged');
    await screen.findByText('INV-2026-0001');
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(
      await screen.findByText(/Would tag 5 of 10 lines; 4 already tagged, 1 fit no rule\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/inv-1 → 4100/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Commit' }));
    expect(await screen.findByText(/Tagged 5 lines; 1 fit no rule\./)).toBeInTheDocument();
    expect(lastCall('/accounting/backfill/commit', 'POST')?.body).toEqual({});
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });

  it('sends the period with the backfill and shows its error', async () => {
    open('/accounting/untagged');
    await screen.findByText('INV-2026-0001');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    await waitFor(() =>
      expect(lastCall('/accounting/backfill/dry-run', 'POST')?.body).toEqual({
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    );
    handler = () => ({ status: 400, body: { error: { code: 'invalid_period', message: 'x' } } });
    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(await screen.findByText('The period starts after it ends.')).toBeInTheDocument();
  });

  it('is closed to a caller who may not tag', async () => {
    permissions = [accountingPermissions.exportRead];
    open('/accounting/untagged');
    expect(
      await screen.findByText('You do not have permission to open this page.'),
    ).toBeInTheDocument();
  });
});

describe('mapping rules and chart (BR-1)', () => {
  it('lists the rules, adds one with conditions, and sends the accounts and date', async () => {
    open('/accounting/rules');
    expect(await screen.findByText('kind=advance')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save rule' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('combobox', { name: 'Document type' }));
    await userEvent.click(await screen.findByTitle('Receipt'));
    await userEvent.type(
      screen.getByLabelText('Conditions (name=value, one per line)'),
      'method=cash{enter}kind = x',
    );
    await pick('Debit account', '1210 Trade receivables (clients)');
    await pick('Credit account', '4100 Contract revenue, construction');
    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2026-07-01' } });
    await userEvent.click(save);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(lastCall('/accounting/mapping-rules', 'PUT')?.body).toEqual({
      sourceDocType: 'receipt',
      condition: { method: 'cash', kind: 'x' },
      debitAccountCode: '1210',
      creditAccountCode: '4100',
      effectiveFrom: '2026-07-01',
      active: true,
    });
  });

  it('refuses a condition line that is not name=value without calling the API', async () => {
    open('/accounting/rules');
    await screen.findByText('kind=advance');
    await userEvent.type(
      screen.getByLabelText('Conditions (name=value, one per line)'),
      'just words',
    );
    await pick('Debit account', '1210 Trade receivables (clients)');
    await pick('Credit account', '4100 Contract revenue, construction');
    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2026-07-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(
      await screen.findByText('Each condition line must look like name=value.'),
    ).toBeInTheDocument();
    expect(lastCall('/accounting/mapping-rules', 'PUT')).toBeUndefined();
  });

  it('edits a rule with its version and shows a conflict', async () => {
    open('/accounting/rules');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Conditions (name=value, one per line)')).toHaveValue(
      'kind=advance',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
    handler = (url, init) =>
      url === '/accounting/mapping-rules' && init.method === 'PUT'
        ? { status: 409, body: { error: { code: 'version_conflict', message: 'x' } } }
        : url.startsWith('/accounting/accounts')
          ? { body: accounts }
          : { body: [rule] };
    await userEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(
      await screen.findByText('Someone else changed this. Reload and try again.'),
    ).toBeInTheDocument();
    expect(lastCall('/accounting/mapping-rules', 'PUT')?.body).toMatchObject({
      id: 'rule-1',
      version: 2,
      active: false,
    });
  });

  it('shows the chart and switches an account on and off', async () => {
    open('/accounting/rules');
    expect(await screen.findByText('Contract revenue, construction')).toBeInTheDocument();
    expect(screen.queryByText('Other overheads')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show switched-off accounts' }));
    const row = (await screen.findByText('Other overheads')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Switch on' }));
    await waitFor(() =>
      expect(lastCall('/accounting/accounts/6900', 'PUT')?.body).toEqual({
        active: true,
        version: 4,
      }),
    );
    const on = screen.getByText('Contract revenue, construction').closest('tr') as HTMLElement;
    expect(within(on).getByRole('button', { name: 'Switch off' })).toBeInTheDocument();
  });

  it('shows an empty list and hides every editing control from a read-only caller', async () => {
    permissions = [accountingPermissions.exportRead, accountingPermissions.rulesManage];
    handler = (url) => (url === '/accounting/mapping-rules' ? { body: [] } : undefined);
    open('/accounting/rules');
    expect(
      await screen.findByText(
        'No rules yet. Exports work with blank account codes until rules or tags are added.',
      ),
    ).toBeInTheDocument();
  });

  it('reports a failed switch', async () => {
    open('/accounting/rules');
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Show switched-off accounts' }),
    );
    const row = (await screen.findByText('Other overheads')).closest('tr') as HTMLElement;
    handler = () => ({ status: 409, body: { error: { code: 'version_conflict', message: 'x' } } });
    await userEvent.click(within(row).getByRole('button', { name: 'Switch on' }));
    expect(
      await screen.findByText('Someone else changed this. Reload and try again.'),
    ).toBeInTheDocument();
  });
});
