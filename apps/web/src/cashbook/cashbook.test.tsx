import { cashbookPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { entryProblem, isPositiveAmount, isSignedAmount, optional, transferProblem } from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const till = {
  id: 'a1',
  code: 'TILL',
  name: 'Main till',
  kind: 'cash',
  bankName: null,
  accountNumberMasked: null,
  accountCodeTag: null,
  openingBalance: '1000.00',
  openingDate: '2026-01-01',
  allowOverdraft: false,
  active: true,
  version: 1,
  balance: '1500.00',
};
const bank = {
  ...till,
  id: 'a2',
  code: 'BANK',
  name: 'Synthetic Bank',
  kind: 'bank',
  balance: '200.00',
};

const txn = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  number: 'CB-2026-00001',
  accountId: 'a1',
  txnDate: '2026-11-18',
  direction: 'in',
  amount: '500.00',
  txnType: 'receipt',
  method: 'cash',
  reference: null,
  description: 'Stage payment',
  accountTag: null,
  reconciledIn: null,
  reversesId: null,
  reversed: false,
  transferPairId: null,
  runningBalance: '1500.00',
  ...over,
});

const page = (items: unknown[]) => ({ items, total: items.length, limit: 100, offset: 0 });

const detail = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  accountId: 'a2',
  statementFrom: '2026-11-01',
  statementTo: '2026-11-18',
  statementClosingBalance: '1810.00',
  bookBalanceAtEnd: null,
  difference: null,
  status: 'draft',
  version: 1,
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      lineDate: '2026-11-13',
      description: 'Deposit',
      debit: '0.00',
      credit: '500.00',
      matchedTransactionId: null,
    },
    {
      id: 'l2',
      lineNo: 2,
      lineDate: '2026-11-15',
      description: 'Interest',
      debit: '0.00',
      credit: '10.00',
      matchedTransactionId: null,
    },
  ],
  candidates: [
    txn({ id: 't1', accountId: 'a2' }),
    txn({ id: 't2', direction: 'out', amount: '200.00' }),
  ],
  suggestions: [{ lineId: 'l1', transactionId: 't1', dayDifference: 0 }],
  figures: {
    bookBalance: '1600.00',
    bookUnreconciled: '300.00',
    statementUnreconciled: '510.00',
    expectedClosing: '1810.00',
    difference: '0.00',
  },
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = () => undefined;
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
      const { status = 200, body } = handler(url, init) ?? { body: {} };
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  await userEvent.click(await screen.findByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByTitle(option));
};

describe('form checks', () => {
  it('checks amounts and optional text', () => {
    expect(isPositiveAmount('10.5')).toBe(true);
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('1.234')).toBe(false);
    expect(isSignedAmount('-5')).toBe(true);
    expect(isSignedAmount('x')).toBe(false);
    expect(optional('  ')).toBeUndefined();
    expect(optional(' a ')).toBe('a');
  });

  it('finds the first problem of an entry and of a transfer', () => {
    const ok = { accountId: 'a', txnDate: '2026-11-18', amount: '5' };
    expect(entryProblem(ok)).toBeNull();
    expect(entryProblem({ ...ok, accountId: '' })).toBe('account');
    expect(entryProblem({ ...ok, txnDate: '' })).toBe('date');
    expect(entryProblem({ ...ok, amount: '0' })).toBe('amount');
    const transfer = { fromAccountId: 'a', toAccountId: 'b', txnDate: '2026-11-18', amount: '5' };
    expect(transferProblem(transfer)).toBeNull();
    expect(transferProblem({ ...transfer, toAccountId: '' })).toBe('account');
    expect(transferProblem({ ...transfer, toAccountId: 'a' })).toBe('same');
    expect(transferProblem({ ...transfer, txnDate: '' })).toBe('date');
    expect(transferProblem({ ...transfer, amount: 'x' })).toBe('amount');
  });
});

describe('accounts', () => {
  it('lists accounts with balances and adds one', async () => {
    handler = (url, init) =>
      url.startsWith('/cashbook/accounts?')
        ? { body: [till, { ...bank, active: false }] }
        : init.method === 'POST'
          ? { body: till }
          : undefined;
    open('/cashbook/accounts');
    expect(await screen.findByText('Main till')).toBeInTheDocument();
    expect(screen.getByText('1,500.00')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(
      await screen.findByText('Enter a code, a name and an opening date.'),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Code' }), 'SAFE');
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Safe');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Opening balance' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Opening balance' }), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(await screen.findByText(/opening balance must be a number/)).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Opening balance' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Opening balance' }), '250');
    await userEvent.type(screen.getByRole('textbox', { name: 'Bank name' }), 'Synthetic Bank');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Masked account number' }),
      '****1234',
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Account tag' }), '1001');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      code: 'SAFE',
      name: 'Safe',
      kind: 'cash',
      openingBalance: '250',
      bankName: 'Synthetic Bank',
      accountNumberMasked: '****1234',
      accountCodeTag: '1001',
      allowOverdraft: false,
    });
  });

  it('deactivates an account and hides the form without the permission', async () => {
    handler = (url) => (url.startsWith('/cashbook/accounts?') ? { body: [till] } : undefined);
    open('/cashbook/accounts');
    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/cashbook/accounts/a1',
      body: { name: 'Main till', active: false, version: 1 },
    });
  });

  it('a reader without the manage permission sees no form', async () => {
    permissions = [cashbookPermissions.txnRead];
    handler = (url) => (url.startsWith('/cashbook/accounts?') ? { body: [till] } : undefined);
    open('/cashbook/accounts');
    expect(await screen.findByText('Main till')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
  });
});

describe('cash book', () => {
  const bookHandler = (items: unknown[]) => {
    handler = (url, init) =>
      url.startsWith('/cashbook/accounts?')
        ? { body: [till, bank] }
        : url.startsWith('/cashbook/transactions?')
          ? { body: page(items) }
          : init.method === 'POST' || init.method === 'PUT'
            ? { body: [] }
            : undefined;
  };

  it('shows each movement with the balance after it and the reversal trail', async () => {
    bookHandler([
      txn(),
      txn({
        id: 't2',
        number: 'CB-2026-00002',
        direction: 'out',
        amount: '30.00',
        txnType: 'payment',
        description: null,
        runningBalance: '1470.00',
        reversed: true,
      }),
      txn({
        id: 't3',
        number: 'CB-2026-00003',
        direction: 'out',
        amount: '500.00',
        reversesId: 't1',
        description: null,
        accountTag: '4010',
        runningBalance: '970.00',
      }),
    ]);
    open('/cashbook/book');
    expect(await screen.findByText('CB-2026-00001')).toBeInTheDocument();
    expect(screen.getAllByText('1,500.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Reversed')).toBeInTheDocument();
    expect(screen.getByText('Reversal')).toBeInTheDocument();
    expect(screen.getByText('4010')).toBeInTheDocument();
    // Only an entry that is not reversed, not a reversal and not reconciled can be reversed.
    expect(screen.getAllByRole('button', { name: 'Reverse' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'New receipt' })).toBeInTheDocument();
  });

  it('asks for a reason, then reverses', async () => {
    bookHandler([txn()]);
    open('/cashbook/book');
    await userEvent.click(await screen.findByRole('button', { name: 'Reverse' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reverse' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'Entered twice');
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/reverse'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/reverse'))?.body).toEqual({
      reason: 'Entered twice',
    });
  });

  it('filters by account and dates', async () => {
    bookHandler([txn()]);
    open('/cashbook/book');
    await screen.findByText('CB-2026-00001');
    await choose('Account', 'BANK Synthetic Bank');
    await userEvent.type(screen.getByLabelText('From date'), '2026-11-01');
    await userEvent.type(screen.getByLabelText('To date'), '2026-11-30');
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('accountId=a2') &&
            c.url.includes('from=2026-11-01') &&
            c.url.includes('to=2026-11-30'),
        ),
      ).toBe(true),
    );
  });

  it('hides the entry links and the reverse button without the permissions', async () => {
    permissions = [cashbookPermissions.txnRead];
    bookHandler([txn()]);
    open('/cashbook/book');
    expect(await screen.findByText('CB-2026-00001')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New receipt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument();
  });

  it('the needs-tag list lets the accountant set a tag', async () => {
    bookHandler([txn()]);
    open('/cashbook/needs-tag');
    expect(await screen.findByText('Transactions that need an account tag')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('needsTag=true'))).toBe(true);
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Account tag CB-2026-00001' }),
      '4010',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save tag' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/tag'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/tag'))?.body).toEqual({ accountTag: '4010' });
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument();
  });
});

describe('new entries', () => {
  const entryHandler = () => {
    handler = (url, init) =>
      url.startsWith('/cashbook/accounts?')
        ? { body: [till, bank] }
        : url.startsWith('/cashbook/transactions?')
          ? { body: page([]) }
          : init.method === 'POST'
            ? { body: url.endsWith('approval-requests') ? { approvalDocId: 'doc-1' } : {} }
            : undefined;
  };

  it('records a receipt after checking the form', async () => {
    entryHandler();
    open('/cashbook/receipts/new');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose the account.')).toBeInTheDocument();
    await choose('Account', 'TILL Main till (1500.00)');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Enter an amount above zero/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount' }), '125.5');
    await userEvent.type(screen.getByRole('textbox', { name: 'Reference' }), 'CHQ-1');
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'Stage 1');
    await userEvent.type(screen.getByRole('textbox', { name: 'Account tag' }), '4010');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/cashbook/receipts')).toBe(true));
    expect(calls.find((c) => c.url === '/cashbook/receipts')?.body).toMatchObject({
      accountId: 'a1',
      amount: '125.5',
      method: 'cash',
      reference: 'CHQ-1',
      description: 'Stage 1',
      accountTag: '4010',
    });
    // Back to the cash book after saving.
    expect(await screen.findByText('No transactions in this view.')).toBeInTheDocument();
  });

  it('asks the owner to approve a payment and sends the approval id with it', async () => {
    entryHandler();
    open('/cashbook/payments/new');
    await choose('Account', 'TILL Main till (1500.00)');
    await userEvent.click(await screen.findByRole('button', { name: 'Ask the owner to approve' }));
    expect(await screen.findByText(/Enter an amount above zero/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount' }), '40');
    await userEvent.click(screen.getByRole('button', { name: 'Ask the owner to approve' }));
    expect(await screen.findByText(/The owner was asked/)).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/cashbook/approval-requests')?.body).toEqual({
      docType: 'payment',
      amount: '40',
      accountId: 'a1',
    });
    expect(screen.getByRole('textbox', { name: 'Approval id' })).toHaveValue('doc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/cashbook/payments')).toBe(true));
    expect(calls.find((c) => c.url === '/cashbook/payments')?.body).toMatchObject({
      approvalDocId: 'doc-1',
      amount: '40',
    });
  });

  it('records a transfer between two different accounts', async () => {
    entryHandler();
    open('/cashbook/transfers/new');
    await choose('From account', 'TILL Main till (1500.00)');
    // The first dropdown still holds the same title, so pick the last one on the page.
    await userEvent.click(await screen.findByRole('combobox', { name: 'To account' }));
    await userEvent.click(
      (await screen.findAllByTitle('TILL Main till (1500.00)')).at(-1) as Element,
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount' }), '70');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose two different accounts.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'To account' }));
    await userEvent.click(
      (await screen.findAllByTitle('BANK Synthetic Bank (200.00)')).at(-1) as Element,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/cashbook/transfers')).toBe(true));
    expect(calls.find((c) => c.url === '/cashbook/transfers')?.body).toMatchObject({
      fromAccountId: 'a1',
      toAccountId: 'a2',
      amount: '70',
    });
  });

  it('refuses to open an entry page without the create permission', async () => {
    permissions = [cashbookPermissions.txnRead];
    entryHandler();
    open('/cashbook/receipts/new');
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});

describe('position and pending advances', () => {
  it('shows the totals and the accounts of the day', async () => {
    handler = (url) =>
      url.startsWith('/cashbook/position')
        ? {
            body: {
              date: '2026-11-18',
              accounts: [
                {
                  accountId: 'a1',
                  code: 'TILL',
                  name: 'Main till',
                  kind: 'cash',
                  balance: '1500.00',
                  movementIn: '500.00',
                  movementOut: '30.00',
                },
              ],
              totalCash: '1500.00',
              totalBank: '200.00',
              total: '1700.00',
              movementIn: '500.00',
              movementOut: '30.00',
            },
          }
        : undefined;
    open('/cashbook/position');
    expect(await screen.findByText('1,700.00')).toBeInTheDocument();
    expect(screen.getByText('Main till')).toBeInTheDocument();
    expect(screen.getByText('+500.00 / -30.00')).toBeInTheDocument();
  });

  it('records a waiting advance from the chosen account', async () => {
    handler = (url, init) =>
      url.startsWith('/cashbook/accounts?')
        ? { body: [till] }
        : url.startsWith('/cashbook/pending?')
          ? {
              body: [
                {
                  id: 'p1',
                  sourceDocId: 'x',
                  amount: '300.00',
                  txnDate: '2026-11-17',
                  description: 'Advance ADV-1 to custodian',
                  status: 'pending',
                  note: 'Short by 10.00',
                },
              ],
            }
          : init.method === 'POST'
            ? { body: {} }
            : undefined;
    open('/cashbook/pending');
    expect(await screen.findByText('Advance ADV-1 to custodian')).toBeInTheDocument();
    expect(screen.getByText('Short by 10.00')).toBeInTheDocument();
    const record = screen.getByRole('button', { name: 'Record' });
    expect(record).toBeDisabled();
    await choose('Account Advance ADV-1 to custodian', 'TILL Main till');
    await userEvent.click(record);
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/cashbook/pending/p1/record')).toBe(true),
    );
    expect(calls.find((c) => c.url === '/cashbook/pending/p1/record')?.body).toEqual({
      accountId: 'a1',
    });
  });

  it('says nothing is waiting', async () => {
    handler = (url) => (url.startsWith('/cashbook/pending?') ? { body: [] } : undefined);
    open('/cashbook/pending');
    expect(await screen.findByText('Nothing is waiting.')).toBeInTheDocument();
  });
});

describe('bank reconciliation', () => {
  const draft = {
    id: 'r1',
    accountId: 'a2',
    statementFrom: '2026-11-01',
    statementTo: '2026-11-18',
    statementClosingBalance: '1810.00',
    bookBalanceAtEnd: null,
    difference: null,
    status: 'draft',
    version: 1,
  };

  it('lists the statements and starts a new one', async () => {
    handler = (url, init) =>
      url === '/cashbook/reconciliations' && init.method === 'GET'
        ? { body: [draft, { ...draft, id: 'r2', status: 'completed' }] }
        : url.startsWith('/cashbook/accounts?')
          ? { body: [bank] }
          : url === '/cashbook/reconciliations' && init.method === 'POST'
            ? { body: draft }
            : url === '/cashbook/reconciliations/r1'
              ? { body: detail() }
              : undefined;
    open('/cashbook/reconciliations');
    expect(await screen.findAllByText('BANK Synthetic Bank')).toHaveLength(2);
    expect(screen.getByText('Completed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(
      await screen.findByText('Choose the account and the statement dates.'),
    ).toBeInTheDocument();
    await choose('Account', 'BANK Synthetic Bank');
    await userEvent.type(screen.getByLabelText('Statement from'), '2026-11-01');
    await userEvent.type(screen.getByLabelText('Statement to'), '2026-11-18');
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/closing balance must be a number/)).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Statement closing balance' }),
      '1810',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      accountId: 'a2',
      statementFrom: '2026-11-01',
      statementTo: '2026-11-18',
      statementClosingBalance: '1810',
    });
    // The workspace of the new statement opens.
    expect(await screen.findByText('Difference')).toBeInTheDocument();
  });

  it('imports a statement, accepts the suggestions, and completes at zero', async () => {
    let current = detail({ lines: [], suggestions: [] });
    handler = (url, init) => {
      if (url === '/cashbook/reconciliations/r1/import') {
        current = detail();
        return { body: current };
      }
      if (url === '/cashbook/reconciliations/r1/match') {
        current = detail({
          lines: detail().lines.map((l) =>
            l.id === 'l1' ? { ...l, matchedTransactionId: 't1' } : l,
          ),
          suggestions: [],
        });
        return { body: current };
      }
      if (url === '/cashbook/reconciliations/r1/complete') {
        return { body: detail({ status: 'completed' }) };
      }
      if (url === '/cashbook/reconciliations/r1' && init.method === 'GET') return { body: current };
      return undefined;
    };
    open('/cashbook/reconciliations/r1');
    expect(await screen.findByText('No statement lines yet. Import a CSV.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept 0 suggested matches' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import statement' })).toBeDisabled();

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Statement CSV' }),
      'date,description,debit,credit',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import statement' }));
    expect(await screen.findByText('Deposit')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept 1 suggested matches' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/match'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/match'))?.body).toEqual({
      matches: [{ lineId: 'l1', transactionId: 't1' }],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reopen/ })).toBeInTheDocument();
  });

  it('clears a match from the line, and cannot complete while the difference is not zero', async () => {
    const matched = detail({
      lines: detail().lines.map((l) => (l.id === 'l1' ? { ...l, matchedTransactionId: 't1' } : l)),
      figures: { ...detail().figures, difference: '5.00' },
    });
    handler = (url, init) => {
      if (url === '/cashbook/reconciliations/r1/match') return { body: detail() };
      return url === '/cashbook/reconciliations/r1' && init.method === 'GET'
        ? { body: matched }
        : undefined;
    };
    open('/cashbook/reconciliations/r1');
    expect(await screen.findByText(/differ by .*5.00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete' })).toBeDisabled();
    const select = screen.getByRole('combobox', { name: 'Matched to 1' });
    await userEvent.hover(select);
    const clear = document.querySelector('.ant-select-clear');
    expect(clear).not.toBeNull();
    await userEvent.click(clear as Element);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/match'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/match'))?.body).toEqual({
      matches: [{ lineId: 'l1', transactionId: null }],
    });
  });

  it('matches a line by hand from the entries of the same money', async () => {
    handler = (url, init) => {
      if (url === '/cashbook/reconciliations/r1/match') return { body: detail() };
      return url === '/cashbook/reconciliations/r1' && init.method === 'GET'
        ? { body: detail() }
        : undefined;
    };
    open('/cashbook/reconciliations/r1');
    await screen.findByText('Deposit');
    await userEvent.click(screen.getByRole('combobox', { name: 'Matched to 1' }));
    // Only the receipt of 500 fits the deposit; the payment of 200 is not offered.
    const options = await screen.findAllByTitle(/CB-2026-00001/);
    expect(options.length).toBeGreaterThan(0);
    expect(screen.queryByTitle(/200\.00/)).not.toBeInTheDocument();
    await userEvent.click(options[0] as Element);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/match'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/match'))?.body).toEqual({
      matches: [{ lineId: 'l1', transactionId: 't1' }],
    });
  });

  it('reopens a completed statement and shows it read-only', async () => {
    let status = 'completed';
    handler = (url, init) => {
      if (url === '/cashbook/reconciliations/r1/reopen') {
        status = 'draft';
        return { body: detail() };
      }
      return url === '/cashbook/reconciliations/r1' && init.method === 'GET'
        ? {
            body: detail({
              status,
              lines: detail().lines.map((l) => ({
                ...l,
                matchedTransactionId: l.id === 'l1' ? 't1' : null,
              })),
            }),
          }
        : undefined;
    };
    open('/cashbook/reconciliations/r1');
    expect(await screen.findByText('Matched')).toBeInTheDocument();
    expect(screen.getByText('Not matched')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import statement' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Reopen/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/reopen'))).toBe(true));
    expect(await screen.findByRole('button', { name: 'Import statement' })).toBeInTheDocument();
  });
});
