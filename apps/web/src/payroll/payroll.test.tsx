import { payrollPermissions } from '@emporium/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { monthLabel, today } from './hooks';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let permissions: string[];
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const page = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });
const bank = {
  id: 'a1',
  code: 'BANK',
  name: 'Synthetic Bank',
  kind: 'bank',
  active: true,
  version: 1,
  balance: '0.00',
};
const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  periodId: 'per1',
  year: 2026,
  month: 10,
  status: 'draft',
  revision: 1,
  finalizedAt: null,
  totalNet: '3000.00',
  totalPaid: '0.00',
  totalUnpaid: '3000.00',
  costDifferenceTreatment: 'spread_to_projects',
  version: 1,
  lineCount: 2,
  paidLineCount: 0,
  cost: { grossPay: '3100.00', allocatedCost: '3000.00', difference: '100.00', adjustments: [] },
  ...over,
});
const line = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  runId: 'r1',
  workerId: 'w1',
  workerCode: 'W-001',
  workerName: 'Synthetic Worker One',
  netPay: '1500.00',
  paymentMethod: null,
  paymentStatus: 'unpaid',
  paidOn: null,
  paymentId: null,
  cashbookTxnId: null,
  payslipNumber: 'PSL-2026-0001',
  ...over,
});
const paidLine = line({
  id: 'l2',
  workerCode: 'W-002',
  workerName: 'Synthetic Worker Two',
  paymentStatus: 'paid',
  paidOn: '2026-11-05',
  payslipNumber: null,
});
const payment = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  paymentDate: '2026-11-05',
  method: 'cash',
  accountId: 'a1',
  amount: '1500.00',
  status: 'paid',
  reversalReason: null,
  lineIds: ['l2'],
  version: 1,
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
      const base: Reply | undefined = url.startsWith('/cashbook/accounts')
        ? { body: [bank] }
        : undefined;
      const { status = 200, body } = handler(url, init) ?? base ?? { body: {} };
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
const sent = (suffix: string) => calls.find((c) => c.method !== 'GET' && c.url.endsWith(suffix));

const serve =
  (runBody: unknown, lines: unknown[], payments: unknown[] = []) =>
  (url: string): Reply | undefined => {
    if (url === '/payroll/runs/r1') return { body: runBody };
    if (url === '/payroll/runs/r1/lines') return { body: lines };
    if (url === '/payroll/runs/r1/payments') return { body: payments };
    return undefined;
  };

describe('helpers', () => {
  it('formats a month and today', () => {
    expect(monthLabel(2026, 3)).toBe('2026-03');
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('runs list', () => {
  it('lists runs and creates one from an approved period that has no run yet', async () => {
    handler = (url, init) => {
      if (url.startsWith('/payroll/runs') && init.method === 'POST') return { body: run() };
      if (url.startsWith('/payroll/runs')) return { body: page([run({ status: 'paid' })]) };
      if (url.startsWith('/wages/periods')) {
        return {
          body: page([
            { id: 'per1', year: 2026, month: 10, status: 'approved' },
            { id: 'per2', year: 2026, month: 11, status: 'approved' },
            { id: 'per3', year: 2026, month: 12, status: 'draft' },
          ]),
        };
      }
      return undefined;
    };
    open('/payroll/runs');
    expect(await screen.findByRole('link', { name: '2026-10' })).toBeInTheDocument();
    await choose('Period', '2026-11');
    await userEvent.click(screen.getByRole('button', { name: 'Create run' }));
    await waitFor(() => expect(sent('/payroll/runs')?.body).toEqual({ periodId: 'per2' }));
  });

  it('shows the module message when creating fails, and hides creation without permission', async () => {
    handler = (url, init) => {
      if (url.startsWith('/payroll/runs') && init.method === 'POST') {
        return {
          status: 409,
          body: { error: { code: 'period_not_approved', message: 'Not approved' } },
        };
      }
      if (url.startsWith('/payroll/runs')) return { body: page([]) };
      if (url.startsWith('/wages/periods')) {
        return { body: page([{ id: 'per1', year: 2026, month: 10, status: 'approved' }]) };
      }
      return undefined;
    };
    open('/payroll/runs');
    await choose('Period', '2026-10');
    await userEvent.click(screen.getByRole('button', { name: 'Create run' }));
    expect((await screen.findAllByText('Not approved')).length).toBeGreaterThan(0);
  });

  it('shows no creation controls to a reader and an empty list', async () => {
    permissions = [payrollPermissions.runRead];
    handler = (url) => (url.startsWith('/payroll/runs') ? { body: page([]) } : undefined);
    open('/payroll/runs');
    expect(await screen.findByText('No payroll runs yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create run' })).toBeNull();
  });

  it('shows a load error', async () => {
    handler = (url) => (url.startsWith('/payroll/runs') ? { status: 500, body: {} } : undefined);
    open('/payroll/runs');
    expect((await screen.findAllByText(/could not|failed/i)).length).toBeGreaterThan(0);
  });
});

describe('run page', () => {
  it('shows the cost difference and finalizes with the chosen treatment', async () => {
    handler = serve(run(), [line(), paidLine]);
    open('/payroll/runs/r1');
    expect(await screen.findByText(/Difference: 100\.00/)).toBeInTheDocument();
    await choose('Cost difference treatment', 'Post to overhead');
    await userEvent.click(screen.getByRole('button', { name: 'Finalize run' }));
    await waitFor(() =>
      expect(sent('/finalize')?.body).toEqual({
        version: 1,
        costDifferenceTreatment: 'overhead',
      }),
    );
  });

  it('shows a failed finalize and no payment controls for a draft', async () => {
    handler = (url, init) =>
      url.endsWith('/finalize') && init.method === 'POST'
        ? { status: 409, body: { error: { code: 'x', message: 'Cannot finalize' } } }
        : serve(run(), [line()])(url);
    open('/payroll/runs/r1');
    await userEvent.click(await screen.findByRole('button', { name: 'Finalize run' }));
    expect((await screen.findAllByText('Cannot finalize')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Pay all unpaid' })).toBeNull();
  });

  it('pays selected lines inside the approval band with no approval request', async () => {
    handler = (url, init) => {
      if (url.endsWith('/payment-requests')) {
        return { body: { approvalDocId: null, amount: '1500.00', lineIds: ['l1'] } };
      }
      if (url.endsWith('/pay') && init.method === 'POST') return { body: payment() };
      return serve(run({ status: 'part_paid' }), [line(), paidLine], [payment()])(url);
    };
    open('/payroll/runs/r1');
    await screen.findByText('Synthetic Worker One');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[2]).toBeDisabled();
    await userEvent.click(boxes[1] as HTMLElement);
    await choose('Pay from account', 'BANK Synthetic Bank');
    await userEvent.click(screen.getByRole('button', { name: 'Pay 1 selected' }));
    await waitFor(() => expect(sent('/pay')).toBeDefined());
    expect(sent('/payment-requests')?.body).toEqual({ lineIds: ['l1'] });
    expect(sent('/pay')?.body).toMatchObject({
      lineIds: ['l1'],
      method: 'cash',
      accountId: 'a1',
      version: 1,
    });
    expect(sent('/pay')?.body).not.toHaveProperty('approvalDocId');
  });

  it('asks for approval above the band and sends the document with the payment', async () => {
    handler = (url, init) => {
      if (url.endsWith('/payment-requests')) {
        return { body: { approvalDocId: 'd1', amount: '3000.00', lineIds: ['l1'] } };
      }
      if (url.endsWith('/pay') && init.method === 'POST') {
        return {
          status: 409,
          body: { error: { code: 'approval_pending', message: 'Waiting for the owner' } },
        };
      }
      return serve(run({ status: 'finalized' }), [line()])(url);
    };
    open('/payroll/runs/r1');
    await choose('Pay from account', 'BANK Synthetic Bank');
    await userEvent.click(await screen.findByRole('button', { name: 'Pay all unpaid' }));
    expect((await screen.findAllByText('Waiting for the owner')).length).toBeGreaterThan(0);
    expect(screen.getByText(/needs approval/)).toBeInTheDocument();
    expect(sent('/payment-requests')?.body).toEqual({});
    expect(sent('/pay')?.body).toMatchObject({ approvalDocId: 'd1' });
    expect(sent('/pay')?.body).not.toHaveProperty('lineIds');
  });

  it('reopens an unpaid finalized run with a reason and links payslips', async () => {
    handler = serve(run({ status: 'finalized' }), [line()]);
    open('/payroll/runs/r1');
    const reopen = await screen.findByRole('button', { name: 'Reopen run' });
    expect(reopen).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason'), 'Wrong sheet');
    await userEvent.click(reopen);
    await waitFor(() =>
      expect(sent('/reopen')?.body).toEqual({ reason: 'Wrong sheet', version: 1 }),
    );
    expect(screen.getByRole('link', { name: 'PSL-2026-0001' })).toHaveAttribute(
      'href',
      '/payroll/payslips/l1',
    );
    expect(screen.getByRole('link', { name: 'Payslips of the run (PDF)' })).toHaveAttribute(
      'href',
      '/payroll/runs/r1/payslips.pdf',
    );
  });

  it('reverses a payment with a reason', async () => {
    handler = serve(
      run({ status: 'part_paid' }),
      [paidLine],
      [payment(), payment({ id: 'p2', status: 'reversed' })],
    );
    open('/payroll/runs/r1');
    const reverse = await screen.findByRole('button', { name: 'Reverse' });
    expect(reverse).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason'), 'Paid twice');
    await userEvent.click(reverse);
    await waitFor(() =>
      expect(sent('/payments/p1/reverse')?.body).toEqual({ reason: 'Paid twice', version: 1 }),
    );
  });

  it('hides action controls from a reader and from a fully paid run', async () => {
    permissions = [payrollPermissions.runRead];
    handler = serve(run({ status: 'finalized' }), [line()], []);
    open('/payroll/runs/r1');
    await screen.findByText('Synthetic Worker One');
    expect(screen.queryByRole('button', { name: 'Reopen run' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pay all unpaid' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'PSL-2026-0001' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Payslips of the run (PDF)' })).toBeNull();
  });

  it('shows no payment controls when the run is paid, and a load error', async () => {
    handler = serve(run({ status: 'paid' }), [paidLine], [payment()]);
    const view = open('/payroll/runs/r1');
    await screen.findByText('Synthetic Worker Two');
    expect(screen.queryByRole('button', { name: 'Pay all unpaid' })).toBeNull();
    view.unmount();
    handler = (url) => (url === '/payroll/runs/r1' ? { status: 500, body: {} } : undefined);
    open('/payroll/runs/r1');
    expect((await screen.findAllByText(/could not|failed/i)).length).toBeGreaterThan(0);
  });

  it('shows the generic message for a failure without a code', async () => {
    handler = (url, init) =>
      url.endsWith('/finalize') && init.method === 'POST'
        ? { status: 500, body: {} }
        : serve(run(), [line()])(url);
    open('/payroll/runs/r1');
    await userEvent.click(await screen.findByRole('button', { name: 'Finalize run' }));
    expect((await screen.findAllByText(/could not|failed/i)).length).toBeGreaterThan(0);
  });
});

describe('unpaid wages', () => {
  it('lists unpaid lines by run and age', async () => {
    handler = (url) =>
      url === '/payroll/unpaid'
        ? {
            body: {
              rows: [
                {
                  runId: 'r1',
                  year: 2026,
                  month: 10,
                  lineId: 'l1',
                  workerCode: 'W-001',
                  workerName: 'Synthetic Worker One',
                  netPay: '1500.00',
                  ageDays: 12,
                },
              ],
              byRun: [
                {
                  runId: 'r1',
                  year: 2026,
                  month: 10,
                  unpaidCount: 1,
                  unpaidAmount: '1500.00',
                  oldestAgeDays: 12,
                },
              ],
              total: '1500.00',
            },
          }
        : undefined;
    open('/payroll/unpaid');
    expect(await screen.findByText('Total unpaid: 1,500.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2026-10' })).toHaveAttribute(
      'href',
      '/payroll/runs/r1',
    );
    expect(screen.getByText('Synthetic Worker One')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    handler = (url) => (url === '/payroll/unpaid' ? { status: 500, body: {} } : undefined);
    open('/payroll/unpaid');
    expect((await screen.findAllByText(/could not|failed/i)).length).toBeGreaterThan(0);
  });
});

describe('payslip', () => {
  const slip = (rate: string | null) => ({
    id: 'l1',
    number: 'PSL-2026-0001',
    workerCode: 'W-001',
    workerName: 'Synthetic Worker One',
    period: '2026-10',
    rate,
    basicPay: '1500.00',
    overtimePay: '0.00',
    allowances: '0.00',
    deductions: '0.00',
    advanceRecovery: '0.00',
    netPay: '1500.00',
    attendance: { presentDays: '26', overtimeHours: '0' },
  });

  it('shows the rate only when the API returns it, and prints', async () => {
    handler = (url) => (url === '/payroll/payslips/l1' ? { body: slip('500.00') } : undefined);
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const view = open('/payroll/payslips/l1');
    expect(await screen.findByText('Rate: 500.00')).toBeInTheDocument();
    expect(screen.getByText('Net pay: 1,500.00')).toBeInTheDocument();
    expect(screen.getByText('Present days: 26 · Overtime hours: 0')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
    view.unmount();
    handler = (url) => (url === '/payroll/payslips/l1' ? { body: slip(null) } : undefined);
    open('/payroll/payslips/l1');
    await screen.findByText('Payslip PSL-2026-0001');
    expect(screen.queryByText(/Rate:/)).toBeNull();
  });

  it('shows a load error', async () => {
    handler = (url) => (url === '/payroll/payslips/l1' ? { status: 404, body: {} } : undefined);
    open('/payroll/payslips/l1');
    expect((await screen.findAllByText(/could not|failed/i)).length).toBeGreaterThan(0);
  });

  it('shows the 403 page without the payslip permission', async () => {
    permissions = [payrollPermissions.runRead];
    open('/payroll/payslips/l1');
    expect(await screen.findByText(/permission/i)).toBeInTheDocument();
  });
});
