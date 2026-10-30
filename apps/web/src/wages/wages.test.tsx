import { wagesPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import type { Line, Lines, PeriodDetail, Reconciliation } from './api';
import { canAdjust, canCalculate, canSubmit, isAmount } from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 100, offset: 0 });

const totals = {
  basicPay: '5000.00',
  overtimePay: '375.00',
  allowances: '0.00',
  deductions: '0.00',
  advanceRecovery: '0.00',
  grossPay: '5375.00',
  netPay: '5375.00',
  roundingAdjustment: '0.00',
};

const period = (over: Partial<PeriodDetail> = {}): PeriodDetail => ({
  id: 'p1',
  year: 2026,
  month: 10,
  from: '2026-10-01',
  to: '2026-10-31',
  status: 'calculated',
  calculatedAt: null,
  totalNet: '0.00',
  submittedBy: null,
  submittedAt: null,
  approvedBy: null,
  approvedAt: null,
  reopenReason: null,
  version: 4,
  totals,
  lineCount: 1,
  warnings: { unapprovedSheets: [], missingSheets: [], shortfalls: [] },
  approval: { status: 'none', requestId: null, currentRole: null, lastComment: null },
  ...over,
});

const line = (over: Partial<Line> = {}): Line => ({
  id: 'l1',
  periodId: 'p1',
  workerId: 'w1',
  workerCode: 'WK-0001',
  workerName: 'Ali Raza',
  payBasis: 'daily_rate',
  rate: '1000.00',
  presentDays: '5.00',
  halfDays: '0.00',
  paidLeaveDays: '0.00',
  offDays: '0.00',
  absentDays: '1.00',
  overtimeHours: '2.00',
  shortfall: '0.00',
  note: null,
  ...totals,
  ...over,
});

const linesOf = (over: Partial<Lines> = {}): Lines => ({
  period: period(),
  lines: [line()],
  adjustments: [
    {
      id: 'a1',
      lineId: 'l1',
      kind: 'allowance',
      amount: '250.00',
      reason: 'Travel',
      addedBy: 'u',
      addedAt: '2026-10-25T10:00:00Z',
    },
  ],
  totals,
  ...over,
});

let detail: PeriodDetail;

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  detail = period();
  handler = (url, init) => {
    if (url.startsWith('/wages/periods?')) {
      return {
        body: page([
          period(),
          period({ id: 'p0', month: 9, status: 'approved', totalNet: '90000.00' }),
        ]),
      };
    }
    if (url === '/wages/periods' && init.method === 'POST') {
      return { status: 201, body: period({ id: 'p2', month: 11, status: 'draft' }) };
    }
    if (url === '/wages/periods/p1') return { body: detail };
    if (url === '/wages/periods/p1/lines') return { body: linesOf() };
    if (url === '/wages/periods/p1/calculate') return { body: linesOf() };
    if (url === '/wages/periods/p1/submit') return { body: period({ status: 'submitted' }) };
    if (url === '/wages/periods/p1/reopen') return { body: period({ status: 'reopened' }) };
    if (url === '/wages/lines/l1/adjustments') return { status: 201, body: linesOf() };
    if (url === '/wages/periods/p1/reconciliation') {
      const rec: Reconciliation = {
        period: period(),
        rows: [
          {
            workerId: 'w1',
            workerCode: 'WK-0001',
            workerName: 'Ali Raza',
            allocated: '5375.00',
            gross: '5675.00',
            difference: '300.00',
          },
          {
            workerId: 'w2',
            workerCode: null,
            workerName: null,
            allocated: '100.00',
            gross: '100.00',
            difference: '0.00',
          },
        ],
        differences: [],
        totals: { allocated: '5475.00', gross: '5775.00', difference: '300.00' },
      };
      return { body: rec };
    }
    if (url.startsWith('/wages/advances?')) {
      return {
        body: page([
          {
            id: 'ad1',
            workerId: 'w1',
            workerCode: 'WK-0001',
            workerName: 'Ali Raza',
            amount: '10000.00',
            issuedOn: '2026-09-01',
            monthlyRecovery: '2000.00',
            balance: '8000.00',
            status: 'open',
            note: null,
            version: 1,
          },
        ]),
      };
    }
    if (url === '/wages/advances' && init.method === 'POST') return { status: 201, body: {} };
    if (url.startsWith('/workforce/workers?')) {
      return { body: page([{ id: 'w1', code: 'WK-0001', fullName: 'Ali Raza' }]) };
    }
    return undefined;
  };
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal('print', vi.fn());
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

const open = (path: string) =>
  render(
    <AppProviders auth={fakeAuth()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

const sent = (method: string, url: string) =>
  calls.find((c) => c.method === method && c.url === url);

describe('form rules', () => {
  it('accepts amounts with at most two decimals above zero', () => {
    expect(isAmount('250')).toBe(true);
    expect(isAmount(' 250.5 ')).toBe(true);
    for (const bad of ['', '0', '0.00', '1.234', '-5', 'abc'])
      expect(isAmount(bad), bad).toBe(false);
  });

  it('knows which states allow calculating, adjusting and submitting', () => {
    expect(['draft', 'calculated', 'reopened'].every(canCalculate)).toBe(true);
    expect(['submitted', 'approved'].some(canCalculate)).toBe(false);
    expect(['calculated', 'reopened'].every(canAdjust)).toBe(true);
    expect(['draft', 'submitted', 'approved'].some(canAdjust)).toBe(false);
    expect(['calculated', 'reopened'].every(canSubmit)).toBe(true);
    expect(['draft', 'submitted', 'approved'].some(canSubmit)).toBe(false);
  });
});

describe('the list of wage sheets', () => {
  it('lists the months and opens a new one', async () => {
    open('/wages/periods');
    expect(await screen.findByText('October 2026')).toBeInTheDocument();
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(screen.getByText('90,000.00')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Month'), '11');
    await user.click(screen.getByRole('button', { name: 'Open the month' }));
    await waitFor(() => expect(sent('POST', '/wages/periods')).toBeDefined());
    expect(sent('POST', '/wages/periods')?.body).toMatchObject({ month: 11 });
  });

  it('shows the API error when the month cannot be opened', async () => {
    handler = (url, init) =>
      url === '/wages/periods' && init.method === 'POST'
        ? { status: 409, body: { error: { code: 'period_exists', message: 'exists' } } }
        : url.startsWith('/wages/periods?')
          ? { body: page([]) }
          : undefined;
    open('/wages/periods');
    expect(await screen.findByText('No wage sheets yet.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open the month' }));
    expect(
      await screen.findByText('A wage sheet already exists for this month.'),
    ).toBeInTheDocument();
  });

  it('hides the form from someone who may only read', async () => {
    permissions = [wagesPermissions.periodRead];
    open('/wages/periods');
    expect(await screen.findByText('October 2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the month' })).not.toBeInTheDocument();
  });
});

describe('the wage sheet', () => {
  it('shows a row per worker with totals, and the drill-down with the adjustments', async () => {
    open('/wages/periods/p1');
    expect(await screen.findByText('WK-0001 Ali Raza')).toBeInTheDocument();
    expect(screen.getByText('Wage sheet: October 2026')).toBeInTheDocument();
    expect(screen.getByText('Calculated')).toBeInTheDocument();
    expect(screen.getAllByText('5,375.00').length).toBeGreaterThan(1);
    await userEvent.setup().click(screen.getByRole('button', { name: /expand row/i }));
    expect(await screen.findByText(/Travel/)).toBeInTheDocument();
    expect(screen.getByText(/Present 5.00/)).toBeInTheDocument();
  });

  it('calculates and prints', async () => {
    open('/wages/periods/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Calculate' }));
    expect(
      await screen.findByText('Wages calculated from approved attendance'),
    ).toBeInTheDocument();
    expect(sent('POST', '/wages/periods/p1/calculate')).toBeDefined();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
  });

  it('submits with the version of the sheet', async () => {
    open('/wages/periods/p1');
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Submit for approval' }));
    expect(await screen.findByText('Wage sheet submitted')).toBeInTheDocument();
    expect(sent('POST', '/wages/periods/p1/submit')?.body).toEqual({
      version: 4,
      acknowledgeWarnings: false,
    });
  });

  it('blocks submission while a sheet is unapproved and until warnings are acknowledged', async () => {
    detail = period({
      warnings: {
        unapprovedSheets: [{ id: 's1', teamId: 't1', date: '2026-10-05', status: 'submitted' }],
        missingSheets: [],
        shortfalls: [],
      },
    });
    const { unmount } = open('/wages/periods/p1');
    expect(
      await screen.findByText(/1 attendance sheet\(s\) are not approved yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toBeDisabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    unmount();

    detail = period({
      warnings: {
        unapprovedSheets: [],
        missingSheets: [{ teamId: 't1', date: '2026-10-06' }],
        shortfalls: [{ workerId: 'w1', workerName: 'Ali Raza', amount: '500.00' }],
      },
    });
    open('/wages/periods/p1');
    expect(await screen.findByText(/1 team day\(s\) have no attendance sheet/)).toBeInTheDocument();
    expect(
      screen.getByText(/Ali Raza has deductions 500.00 above the gross pay/),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Submit for approval' });
    expect(submit).toBeDisabled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(sent('POST', '/wages/periods/p1/submit')?.body).toEqual({
        version: 4,
        acknowledgeWarnings: true,
      }),
    );
  });

  it('adds an allowance with a reason through the dialog', async () => {
    open('/wages/periods/p1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /expand row/i }));
    await user.click(await screen.findByRole('button', { name: 'Add allowance or deduction' }));
    const dialog = await screen.findByRole('dialog');
    const add = within(dialog).getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'deduction');
    await user.type(within(dialog).getByLabelText('Amount'), '120.50');
    await user.type(within(dialog).getByLabelText('Reason'), 'Tool loss');
    await user.click(add);
    expect(await screen.findByText('Adjustment added')).toBeInTheDocument();
    expect(sent('POST', '/wages/lines/l1/adjustments')?.body).toEqual({
      kind: 'deduction',
      amount: '120.50',
      reason: 'Tool loss',
    });
  });

  it('shows the API error of a failed action', async () => {
    const base = handler;
    handler = (url, init) =>
      url === '/wages/periods/p1/calculate'
        ? { status: 422, body: { error: { code: 'period_approved', message: 'x' } } }
        : base(url, init);
    open('/wages/periods/p1');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Calculate' }));
    expect(
      await screen.findByText('The wage sheet is approved. Reopen it before calculating again.'),
    ).toBeInTheDocument();
  });

  it('shows a generic error when the failure is not an API answer', async () => {
    const base = handler;
    let fail = false;
    handler = (url, init) => {
      if (fail && url === '/wages/periods/p1/calculate') throw new Error('network');
      return base(url, init);
    };
    open('/wages/periods/p1');
    const user = userEvent.setup();
    await screen.findByText('WK-0001 Ali Raza');
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Calculate' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });

  it('locks an approved sheet and reopens it with a reason', async () => {
    detail = period({
      status: 'approved',
      approval: {
        status: 'approved',
        requestId: 'r',
        currentRole: null,
        lastComment: 'Looks right',
      },
    });
    open('/wages/periods/p1');
    expect(
      await screen.findByText('This wage sheet is approved and locked. Reopen it to change it.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Looks right')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Calculate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reopen' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Why is the wage sheet reopened?'), 'Wrong rate');
    await user.click(confirm);
    expect(await screen.findByText('Wage sheet reopened')).toBeInTheDocument();
    expect(sent('POST', '/wages/periods/p1/reopen')?.body).toEqual({
      version: 4,
      reason: 'Wrong rate',
    });
  });

  it('says a submitted sheet is with the approver', async () => {
    detail = period({ status: 'submitted' });
    open('/wages/periods/p1');
    expect(
      await screen.findByText('This wage sheet is with the approver, so it cannot be changed.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Calculate' })).not.toBeInTheDocument();
  });

  it('hides actions the person has no permission for', async () => {
    permissions = [wagesPermissions.periodRead];
    open('/wages/periods/p1');
    await screen.findByText('WK-0001 Ali Raza');
    expect(screen.queryByRole('button', { name: 'Calculate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /expand row/i }));
    expect(
      screen.queryByRole('button', { name: 'Add allowance or deduction' }),
    ).not.toBeInTheDocument();
  });

  it('flags a shortfall in the drill-down and an empty sheet', async () => {
    const base = handler;
    handler = (url, init) =>
      url === '/wages/periods/p1/lines'
        ? { body: linesOf({ lines: [line({ shortfall: '75.00' })], adjustments: [] }) }
        : base(url, init);
    open('/wages/periods/p1');
    await userEvent.setup().click(await screen.findByRole('button', { name: /expand row/i }));
    expect(
      await screen.findByText(/Deductions are 75.00 more than the gross pay/),
    ).toBeInTheDocument();
    expect(screen.getByText('No allowances or deductions added.')).toBeInTheDocument();
  });

  it('shows the empty message and keeps submit disabled when nothing is calculated', async () => {
    const base = handler;
    handler = (url, init) =>
      url === '/wages/periods/p1/lines'
        ? { body: linesOf({ lines: [], adjustments: [] }) }
        : base(url, init);
    open('/wages/periods/p1');
    expect(
      await screen.findByText('Nothing calculated yet. Calculate the month to see the wages.'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Submit for approval' })).toBeDisabled();
  });

  it('reports a load error', async () => {
    handler = () => ({ status: 500, body: { error: { code: 'x', message: 'x' } } });
    open('/wages/periods/p1');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('reconciliation', () => {
  it('lists allocated cost against gross pay by worker', async () => {
    open('/wages/periods/p1/reconciliation');
    expect(await screen.findByText('WK-0001 Ali Raza')).toBeInTheDocument();
    expect(screen.getByText('w2')).toBeInTheDocument();
    expect(
      screen.getByText('Allocated 5,475.00, gross pay 5,775.00, difference 300.00'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the wage sheet' })).toHaveAttribute(
      'href',
      '/wages/periods/p1',
    );
  });

  it('reports a load error', async () => {
    handler = () => ({ status: 500, body: { error: { code: 'x', message: 'x' } } });
    open('/wages/periods/p1/reconciliation');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('advances', () => {
  it('lists advances and issues a new one after validation', async () => {
    open('/wages/advances');
    expect(await screen.findByText('8,000.00')).toBeInTheDocument();
    expect(screen.getByText('8,000.00')).toBeInTheDocument();
    const user = userEvent.setup();
    const issue = screen.getByRole('button', { name: 'Issue advance' });
    expect(issue).toBeDisabled();
    await screen.findByRole('option', { name: 'WK-0001 Ali Raza' });
    await user.selectOptions(screen.getByLabelText('Worker'), 'w1');
    await user.type(screen.getByLabelText('Amount'), '5000');
    await user.type(screen.getByLabelText('Monthly recovery'), '6000');
    // The instalment is more than the advance.
    expect(issue).toBeDisabled();
    await user.clear(screen.getByLabelText('Monthly recovery'));
    await user.type(screen.getByLabelText('Monthly recovery'), '1000');
    await user.type(screen.getByLabelText('Note'), 'Rent');
    expect(issue).toBeEnabled();
    await user.click(issue);
    await waitFor(() => expect(sent('POST', '/wages/advances')).toBeDefined());
    expect(sent('POST', '/wages/advances')?.body).toMatchObject({
      workerId: 'w1',
      amount: '5000',
      monthlyRecovery: '1000',
      note: 'Rent',
    });
  });

  it('sends no note when it is blank and shows the API error', async () => {
    const base = handler;
    handler = (url, init) =>
      url === '/wages/advances' && init.method === 'POST'
        ? { status: 422, body: { error: { code: 'worker_not_found', message: 'x' } } }
        : base(url, init);
    open('/wages/advances');
    await screen.findByRole('option', { name: 'WK-0001 Ali Raza' });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Worker'), 'w1');
    await user.type(screen.getByLabelText('Amount'), '5000');
    await user.type(screen.getByLabelText('Monthly recovery'), '1000');
    await user.click(screen.getByRole('button', { name: 'Issue advance' }));
    expect(await screen.findByText('The worker was not found.')).toBeInTheDocument();
    expect(sent('POST', '/wages/advances')?.body).not.toHaveProperty('note');
  });

  it('hides the form from someone who may only read and shows an empty list', async () => {
    permissions = [wagesPermissions.periodRead];
    handler = () => undefined;
    open('/wages/advances');
    expect(await screen.findByText('No advances.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue advance' })).not.toBeInTheDocument();
  });

  it('reports a load error', async () => {
    handler = () => ({ status: 500, body: { error: { code: 'x', message: 'x' } } });
    open('/wages/advances');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});
