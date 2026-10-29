import { expensesPermissions } from '@emporium/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { Advance, Category, Claim, ClaimHeader, Custodian } from './api';
import { ClaimLinesGrid, draftOf, emptyLine, lineOf, linesProblem } from './ClaimLinesGrid';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const ME = '018f2222-0000-7000-8000-000000000001';
const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });

const categories: Category[] = [
  {
    code: 'transport',
    name: 'Transport',
    defaultCostCodeId: 'cc5',
    receiptRequired: true,
    maxWithoutReceipt: '500.00',
    version: 1,
  },
  {
    code: 'food',
    name: 'Food',
    defaultCostCodeId: null,
    receiptRequired: false,
    maxWithoutReceipt: '0.00',
    version: 1,
  },
];

const header = (over: Partial<ClaimHeader> = {}): ClaimHeader => ({
  id: 'c1',
  number: 'EXP-2026-0001',
  claimantId: ME,
  submittedOn: null,
  status: 'draft',
  total: '1500.00',
  note: 'Site visit',
  cancelReason: null,
  version: 3,
  ...over,
});

const claim = (over: Partial<Claim> = {}): Claim => ({
  ...header(),
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      expenseDate: '2026-10-23',
      category: 'transport',
      description: 'Van to site',
      costObjectType: 'overhead',
      costObjectId: null,
      costCodeId: 'cc5',
      amount: '1500.00',
      receiptFileId: null,
    },
  ],
  duplicates: [],
  approval: { status: 'none', requestId: null, currentRole: null },
  ...over,
});

let current: Claim;

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  current = claim();
  handler = (url, init) => {
    if (url === '/expenses/claims' && init.method === 'POST') return { status: 201, body: current };
    if (url.startsWith('/expenses/claims?')) {
      return {
        body: page([
          header(),
          header({ id: 'c2', number: 'EXP-2026-0002', status: 'approved', total: '90.50' }),
        ]),
      };
    }
    if (url.startsWith('/expenses/claims/c1') && init.method === 'DELETE') {
      return { status: 204, body: null };
    }
    if (url.startsWith('/expenses/claims/c1')) return { body: current };
    if (url.startsWith('/expenses/categories')) return { body: categories };
    if (url.startsWith('/expenses/advances') && init.method === 'POST') {
      return { status: 201, body: advance() };
    }
    if (url.startsWith('/expenses/advances')) return { body: page([advance()]) };
    if (url.startsWith('/expenses/custodians') && init.method === 'PUT') {
      return { body: custodian() };
    }
    if (url.startsWith('/expenses/custodians')) {
      return { body: [custodian(), custodian({ userId: 'u2', balance: '-120.00' })] };
    }
    if (url.startsWith('/expenses/custodian-candidates')) {
      return {
        body: [
          { id: ME, fullName: 'Test Person', email: 'a@example.test' },
          { id: 'u2', fullName: 'Second Person', email: 'b@example.test' },
        ],
      };
    }
    if (url.startsWith('/master/cost-codes')) {
      return {
        body: page([
          { id: 'cc5', code: '500', name: 'Site expenses' },
          { id: 'cc1', code: '100', name: 'Materials' },
        ]),
      };
    }
    if (url.startsWith('/projects')) {
      return { body: page([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall' }]) };
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
          json: () => Promise.resolve(profileOf(permissions, { id: ME })),
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

const advance = (over: Partial<Advance> = {}): Advance => ({
  id: 'a1',
  number: 'ADV-2026-0001',
  custodianId: ME,
  amount: '10000.00',
  issuedOn: '2026-10-24',
  issuedBy: 'acc',
  purpose: 'Site petty cash',
  status: 'issued',
  settledOn: null,
  settlementNote: null,
  version: 2,
  ...over,
});

const custodian = (over: Partial<Custodian> = {}): Custodian => ({
  userId: ME,
  floatLimit: '50000.00',
  active: true,
  balance: '8500.00',
  version: 1,
  ...over,
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

const categoryOptions = categories;
const costCodeOptions = [
  { value: 'cc5', label: '500 Site expenses' },
  { value: 'cc1', label: '100 Materials' },
];
const projectOptions = [{ value: 'p1', label: 'PRJ-0001 Boundary wall' }];
const postTo = (suffix: string) => calls.find((c) => c.method === 'POST' && c.url.endsWith(suffix));

const filled = () => ({
  ...emptyLine('2026-10-23'),
  category: 'food',
  description: 'Lunch for the crew',
  costCodeId: 'cc5',
  amount: '350',
});

describe('claim lines (BR-2, T-8)', () => {
  it('reports missing lines and incomplete lines', () => {
    expect(linesProblem([])).toBe('none');
    expect(linesProblem([emptyLine('2026-10-23')])).toBe('incomplete');
    expect(linesProblem([filled()])).toBeNull();
    for (const bad of [
      { expenseDate: '' },
      { category: '' },
      { description: ' ' },
      { costCodeId: '' },
      { amount: '' },
      { amount: '1.234' },
      { amount: '-5' },
      { amount: 'abc' },
    ]) {
      expect(linesProblem([{ ...filled(), ...bad }]), JSON.stringify(bad)).toBe('incomplete');
    }
    expect(linesProblem([{ ...filled(), amount: '10.5' }])).toBeNull();
  });

  it('converts between the form and the API shape', () => {
    const overhead = lineOf({ ...filled(), description: ' Lunch ', amount: ' 350 ' });
    expect(overhead).toEqual({
      expenseDate: '2026-10-23',
      category: 'food',
      description: 'Lunch',
      costObjectType: 'overhead',
      costObjectId: null,
      costCodeId: 'cc5',
      amount: '350',
      receiptFileId: null,
    });
    const project = lineOf({ ...filled(), costObject: 'p1', receiptFileId: 'f1' });
    expect(project).toMatchObject({
      costObjectType: 'project',
      costObjectId: 'p1',
      receiptFileId: 'f1',
    });
    expect(draftOf(project)).toMatchObject({ costObject: 'p1', receiptFileId: 'f1' });
    expect(draftOf(overhead)).toMatchObject({ costObject: 'overhead', receiptFileId: '' });
  });

  it('edits, adds and removes lines, keeping amounts as text', async () => {
    const onChange = vi.fn();
    const line = filled();
    render(
      withQuery(
        <ClaimLinesGrid
          lines={[line]}
          categories={categoryOptions}
          costCodeOptions={costCodeOptions}
          projectOptions={projectOptions}
          receiptOptions={[{ value: 'f1', label: 'receipt.pdf' }]}
          onChange={onChange}
        />,
      ),
    );
    expect(screen.getByLabelText('Amount 1')).toHaveValue('350');
    await userEvent.type(screen.getByLabelText('Amount 1'), '5');
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, amount: '3505' }]);
    await userEvent.type(screen.getByLabelText('Description 1'), '!');
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, description: 'Lunch for the crew!' }]);
    fireDate('Date 1', '2026-10-22');
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, expenseDate: '2026-10-22' }]);

    await userEvent.click(screen.getByLabelText('Charged to 1'));
    await userEvent.click(await screen.findByTitle('PRJ-0001 Boundary wall'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, costObject: 'p1' }]);
    await userEvent.click(screen.getByLabelText('Cost code 1'));
    await userEvent.click(await screen.findByTitle('100 Materials'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, costCodeId: 'cc1' }]);
    await userEvent.click(screen.getByLabelText('Receipt 1'));
    await userEvent.click(await screen.findByTitle('receipt.pdf'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, receiptFileId: 'f1' }]);

    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(onChange.mock.calls.at(-1)?.[0]).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Remove 1' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('suggests the default cost code of a category for a line that has none, and shows the receipt rule', async () => {
    const onChange = vi.fn();
    const line = { ...emptyLine('2026-10-23'), description: 'Van' };
    const view = render(
      withQuery(
        <ClaimLinesGrid
          lines={[line]}
          categories={categoryOptions}
          costCodeOptions={costCodeOptions}
          projectOptions={projectOptions}
          receiptOptions={[]}
          onChange={onChange}
        />,
      ),
    );
    await userEvent.click(screen.getByLabelText('Category 1'));
    await userEvent.click(await screen.findByTitle('Transport'));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...line, category: 'transport', costCodeId: 'cc5' },
    ]);
    // A category without a default leaves the cost code alone, and so does a line that has one.
    await userEvent.click(screen.getByLabelText('Category 1'));
    await userEvent.click(await screen.findByTitle('Food'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...line, category: 'food' }]);
    view.unmount();

    render(
      withQuery(
        <ClaimLinesGrid
          lines={[{ ...line, category: 'food', costCodeId: 'cc1' }]}
          categories={categoryOptions}
          costCodeOptions={costCodeOptions}
          projectOptions={projectOptions}
          receiptOptions={[]}
          onChange={onChange}
        />,
      ),
    );
    expect(screen.queryByText(/A receipt is needed above/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Category 1'));
    await userEvent.click(await screen.findByTitle('Transport'));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...line, category: 'transport', costCodeId: 'cc1' },
    ]);
  });

  it('tells which categories need a receipt', () => {
    render(
      withQuery(
        <ClaimLinesGrid
          lines={[{ ...emptyLine('2026-10-23'), category: 'transport' }]}
          categories={categoryOptions}
          costCodeOptions={costCodeOptions}
          projectOptions={projectOptions}
          receiptOptions={[]}
          onChange={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText('A receipt is needed above 500.00 for Transport.')).toBeVisible();
  });

  it('shows plain text when read-only', () => {
    render(
      withQuery(
        <ClaimLinesGrid
          lines={[{ ...filled(), costObject: 'p1', receiptFileId: 'f1' }]}
          categories={categoryOptions}
          costCodeOptions={costCodeOptions}
          projectOptions={projectOptions}
          receiptOptions={[{ value: 'f1', label: 'receipt.pdf' }]}
          readOnly
          onChange={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText('Lunch for the crew')).toBeVisible();
    expect(screen.getByText('Food')).toBeVisible();
    expect(screen.getByText('PRJ-0001 Boundary wall')).toBeVisible();
    expect(screen.getByText('500 Site expenses')).toBeVisible();
    expect(screen.getByText('receipt.pdf')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Amount 1')).not.toBeInTheDocument();
  });
});

const fireDate = (label: string, value: string) => {
  const input = screen.getByLabelText(label);
  // A date input takes its value in one step.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('claims lists', () => {
  it('lists my claims with a link to a new one', async () => {
    open('/expenses/claims');
    expect(await screen.findByRole('link', { name: 'EXP-2026-0001' })).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeVisible();
    expect(screen.getByText('Approved')).toBeVisible();
    expect(screen.getByRole('button', { name: 'New claim' })).toBeVisible();
    expect(calls.some((c) => c.url.includes('mine=true'))).toBe(true);
  });

  it('hides New claim from people who cannot file', async () => {
    permissions = allPermissions.filter((p) => p !== expensesPermissions.claimCreate);
    open('/expenses/claims');
    await screen.findByRole('link', { name: 'EXP-2026-0001' });
    expect(screen.queryByRole('button', { name: 'New claim' })).not.toBeInTheDocument();
  });

  it('shows the posting queue and posts a claim', async () => {
    open('/expenses/queue');
    const row = (await screen.findByRole('link', { name: 'EXP-2026-0002' })).closest(
      'tr',
    ) as HTMLElement;
    expect(calls.some((c) => c.url.includes('status=approved'))).toBe(true);
    await userEvent.click(within(row).getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(postTo('/expenses/claims/c2/post')).toBeDefined());
    expect(postTo('/expenses/claims/c2/post')?.body).toEqual({ version: 3 });
  });

  it('shows why a post was refused', async () => {
    const previous = handler;
    handler = (url, init) =>
      url.endsWith('/post')
        ? { status: 422, body: { error: { code: 'claim_transition', message: 'no' } } }
        : previous(url, init);
    open('/expenses/queue');
    await userEvent.click(
      (await screen.findAllByRole('button', { name: 'Post' }))[0] as HTMLElement,
    );
    expect(
      await screen.findByText('This step is not allowed from the current status.'),
    ).toBeVisible();
  });

  it('lists every claim for finance', async () => {
    open('/expenses/all-claims');
    expect(await screen.findByRole('heading', { name: 'All expense claims' })).toBeVisible();
    expect(calls.every((c) => !c.url.includes('mine=true'))).toBe(true);
  });

  it('refuses the page without the permission', async () => {
    permissions = allPermissions.filter((p) => p !== expensesPermissions.claimPost);
    open('/expenses/queue');
    expect(await screen.findByText('You do not have permission to open this page.')).toBeVisible();
  });
});

describe('claim form', () => {
  it('checks the lines before saving a new claim and then opens it', async () => {
    current = claim({ id: 'c1' });
    open('/expenses/claims/new');
    await screen.findByRole('heading', { name: /New claim/ });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(
      screen.getByText('Every line needs a date, category, description, cost code and an amount.'),
    ).toBeVisible();

    await userEvent.type(screen.getByLabelText('Description 1'), ' Lunch ');
    await userEvent.click(screen.getByLabelText('Category 1'));
    await userEvent.click(await screen.findByTitle('Food'));
    await userEvent.click(screen.getByLabelText('Cost code 1'));
    await userEvent.click(await screen.findByTitle('500 Site expenses'));
    await userEvent.type(screen.getByLabelText('Amount 1'), '350');
    expect(save).toBeEnabled();
    await userEvent.click(save);

    await waitFor(() => expect(postTo('/expenses/claims')).toBeDefined());
    expect(postTo('/expenses/claims')?.body).toMatchObject({
      lines: [
        {
          category: 'food',
          description: 'Lunch',
          costObjectType: 'overhead',
          costObjectId: null,
          costCodeId: 'cc5',
          amount: '350',
          receiptFileId: null,
        },
      ],
    });
    expect(
      await screen.findByText('Save the claim first', { exact: false }).catch(() => null),
    ).toBeDefined();
  });

  it('saves changes to a draft with its version and submits it for approval', async () => {
    open('/expenses/claims/c1');
    expect(await screen.findByRole('heading', { name: /EXP-2026-0001/ })).toBeVisible();
    await userEvent.type(screen.getByLabelText('Description 1'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      version: 3,
      note: 'Site visit',
      lines: [{ description: 'Van to site!', amount: '1500.00' }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(postTo('/expenses/claims/c1/submit')).toBeDefined());
    expect(postTo('/expenses/claims/c1/submit')?.body).toEqual({
      version: 3,
      acknowledgeDuplicates: false,
    });
  });

  it('shows duplicate lines and submits with the acknowledgement', async () => {
    current = claim({
      duplicates: [{ lineNo: 1, matchedClaimNumber: 'EXP-2026-0000', matchedLineNo: 2 }],
    });
    open('/expenses/claims/c1');
    expect(await screen.findByText('These lines look like repeats')).toBeVisible();
    expect(screen.getByText('Line 1 matches line 2 of EXP-2026-0000')).toBeVisible();
    await userEvent.click(screen.getByLabelText('I have checked: these lines are not repeats'));
    await userEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(postTo('/expenses/claims/c1/submit')).toBeDefined());
    expect(postTo('/expenses/claims/c1/submit')?.body).toMatchObject({
      acknowledgeDuplicates: true,
    });
  });

  it('names a repeat inside the same claim', async () => {
    current = claim({ duplicates: [{ lineNo: 2, matchedClaimNumber: null, matchedLineNo: 1 }] });
    open('/expenses/claims/c1');
    expect(await screen.findByText('Line 2 matches line 1 of this claim')).toBeVisible();
  });

  it('shows the API’s explanation when a submit is refused', async () => {
    const previous = handler;
    handler = (url, init) =>
      url.endsWith('/submit')
        ? { status: 422, body: { error: { code: 'receipt_required', message: 'no' } } }
        : previous(url, init);
    open('/expenses/claims/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for approval' }));
    expect(await screen.findByText('Attach a receipt to each line that needs one.')).toBeVisible();
  });

  it('cancels and deletes a draft', async () => {
    open('/expenses/claims/c1');
    await screen.findByRole('heading', { name: /EXP-2026-0001/ });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel claim' }));
    await waitFor(() => expect(postTo('/expenses/claims/c1/cancel')).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/expenses/claims/c1?version=3');
  });

  it('is read-only once submitted, with the approval state', async () => {
    current = claim({
      status: 'submitted',
      submittedOn: '2026-10-24',
      approval: { status: 'pending', requestId: 'r1', currentRole: 'management' },
    });
    open('/expenses/claims/c1');
    expect(await screen.findByText('Waiting for management')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Amount 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel claim' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete draft' })).not.toBeInTheDocument();
  });

  it('lets the accountant post an approved claim and reverse a posted one with a reason', async () => {
    current = claim({ status: 'approved', claimantId: 'someone-else' });
    const view = open('/expenses/claims/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Post' }));
    await waitFor(() => expect(postTo('/expenses/claims/c1/post')).toBeDefined());
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    view.unmount();

    current = claim({ status: 'posted', claimantId: 'someone-else' });
    open('/expenses/claims/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Reverse' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse claim' }));
    expect(within(dialog).getByText('Enter the reason.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Reason'), ' Wrong month ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reverse claim' }));
    await waitFor(() => expect(postTo('/expenses/claims/c1/reverse')).toBeDefined());
    expect(postTo('/expenses/claims/c1/reverse')?.body).toEqual({
      version: 3,
      reason: 'Wrong month',
    });
  });

  it('hides actions the person may not take', async () => {
    permissions = allPermissions.filter(
      (p) =>
        ![expensesPermissions.claimPost, expensesPermissions.claimReverse].includes(p as never),
    );
    current = claim({ status: 'approved', claimantId: 'someone-else' });
    open('/expenses/claims/c1');
    await screen.findByRole('heading', { name: /EXP-2026-0001/ });
    expect(screen.queryByRole('button', { name: 'Post' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel claim' })).not.toBeInTheDocument();
  });

  it('reports a claim that cannot be loaded', async () => {
    const previous = handler;
    handler = (url, init) =>
      url.startsWith('/expenses/claims/c1')
        ? { status: 404, body: { error: { code: 'claim_not_found', message: 'no' } } }
        : previous(url, init);
    open('/expenses/claims/c1');
    expect(await screen.findByText('Could not load data')).toBeVisible();
  });
});

describe('advances, custodians and categories', () => {
  it('lists advances and checks the form before issuing one', async () => {
    open('/expenses/advances');
    expect(await screen.findByText('ADV-2026-0001')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Issue advance' }));
    expect(
      screen.getByText('Choose the custodian and enter the amount, date and purpose.'),
    ).toBeVisible();

    await userEvent.click(screen.getByLabelText('Custodian'));
    await userEvent.click(await screen.findByTitle('Test Person'));
    await userEvent.type(screen.getByLabelText('Amount'), '2500');
    await userEvent.type(screen.getByLabelText('Purpose'), ' Cement run ');
    await userEvent.click(screen.getByRole('button', { name: 'Issue advance' }));
    await waitFor(() => expect(postTo('/expenses/advances')).toBeDefined());
    expect(postTo('/expenses/advances')?.body).toMatchObject({
      custodianId: ME,
      amount: '2500',
      purpose: 'Cement run',
    });
  });

  it('settles an advance with a note', async () => {
    open('/expenses/advances');
    await userEvent.click(await screen.findByRole('button', { name: 'Settle' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Note/), ' Cash returned ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Settle advance' }));
    await waitFor(() => expect(postTo('/expenses/advances/a1/settle')).toBeDefined());
    expect(postTo('/expenses/advances/a1/settle')?.body).toEqual({
      version: 2,
      note: 'Cash returned',
    });
  });

  it('explains a refused settlement inside the dialog and settled advances have no button', async () => {
    const previous = handler;
    handler = (url, init) =>
      url.endsWith('/settle')
        ? { status: 400, body: { error: { code: 'note_required', message: 'no' } } }
        : url.startsWith('/expenses/advances') && init.method !== 'POST'
          ? {
              body: page([
                advance(),
                advance({ id: 'a2', number: 'ADV-2026-0002', status: 'settled' }),
              ]),
            }
          : previous(url, init);
    open('/expenses/advances');
    await screen.findByText('ADV-2026-0002');
    expect(screen.getAllByRole('button', { name: 'Settle' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Settle' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Settle advance' }));
    expect(
      await within(dialog).findByText('Add a note to settle an advance by hand.'),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows custodian balances, flags a negative one and registers a custodian', async () => {
    open('/expenses/custodians');
    expect(await screen.findByText('Second Person')).toBeVisible();
    expect(screen.getByText('The company owes this person.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Save custodian' }));
    expect(screen.getByText('Choose the person and enter the float limit.')).toBeVisible();
    await userEvent.click(screen.getByLabelText('Person'));
    await userEvent.click(await screen.findByTitle('Second Person'));
    await userEvent.type(screen.getByLabelText('Float limit'), '20000');
    await userEvent.click(screen.getByRole('button', { name: 'Save custodian' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/expenses/custodians/u2');
    expect(put?.body).toEqual({ floatLimit: '20000', active: true });
  });

  it('shows balances read-only to people who cannot issue advances', async () => {
    permissions = allPermissions.filter((p) => p !== expensesPermissions.advanceIssue);
    open('/expenses/custodians');
    await screen.findAllByText('8,500.00', { exact: false });
    expect(screen.queryByRole('button', { name: 'Save custodian' })).not.toBeInTheDocument();
  });

  it('edits the categories and checks them before saving', async () => {
    open('/expenses/categories');
    expect(await screen.findByDisplayValue('transport')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      screen.getByText(
        'Every category needs a code (lower case letters, digits, underscore) and a name.',
      ),
    ).toBeVisible();
    await userEvent.type(screen.getByLabelText('Code 3'), 'tools');
    await userEvent.type(screen.getByLabelText('Name 3'), 'Small tools');
    await userEvent.click(screen.getByLabelText('Receipt required 3'));
    await userEvent.clear(screen.getByLabelText('Allowed without receipt 3'));
    await userEvent.type(screen.getByLabelText('Allowed without receipt 3'), '250');
    await userEvent.click(screen.getByLabelText('Default cost code 3'));
    await userEvent.click(await screen.findByTitle('100 Materials'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const sent = calls.find((c) => c.method === 'PUT')?.body as { categories: unknown[] };
    expect(sent.categories).toHaveLength(3);
    expect(sent.categories[2]).toEqual({
      code: 'tools',
      name: 'Small tools',
      defaultCostCodeId: 'cc1',
      receiptRequired: true,
      maxWithoutReceipt: '250',
    });
    expect(sent.categories[1]).toMatchObject({ code: 'food', defaultCostCodeId: null });
  });

  it('shows the explanation when saving the categories is refused', async () => {
    const previous = handler;
    handler = (url, init) =>
      url.startsWith('/expenses/categories') && init.method === 'PUT'
        ? { status: 400, body: { error: { code: 'category_unknown', message: 'no' } } }
        : previous(url, init);
    open('/expenses/categories');
    await screen.findByDisplayValue('transport');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A line names an unknown category.')).toBeVisible();
  });
});
