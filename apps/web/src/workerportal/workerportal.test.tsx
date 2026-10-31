import { workerportalPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { currentMonth, isMonth } from './form';

type Reply = { status?: number; body: unknown };
let handler: (url: string, init: RequestInit) => Reply | undefined;
let profile: ReturnType<typeof profileOf>;
const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

const workerProfile = () =>
  profileOf([workerportalPermissions.selfRead], { roles: ['worker'], fullName: 'Ali Raza' });

const wageLine = {
  presentDays: '22.00',
  halfDays: '0.00',
  paidLeaveDays: '0.00',
  offDays: '4.00',
  absentDays: '0.00',
  overtimeHours: '6.00',
  basicPay: '22000.00',
  overtimePay: '1125.00',
  allowances: '0.00',
  deductions: '500.00',
  advanceRecovery: '2000.00',
  grossPay: '23125.00',
  netPay: '20625.00',
};

beforeEach(() => {
  calls.length = 0;
  profile = workerProfile();
  handler = (url) => {
    if (url.startsWith('/me/worker/attendance')) {
      return {
        body: {
          month: '2026-10',
          days: [
            { date: '2026-10-22', status: 'present', overtimeHours: '2.00' },
            { date: '2026-10-23', status: 'half_day', overtimeHours: '0.00' },
          ],
        },
      };
    }
    if (url === '/me/worker/advances') {
      return {
        body: { balance: '8000.00', recoveries: [{ month: '2026-10', amount: '2000.00' }] },
      };
    }
    if (url.startsWith('/me/worker/wages?month=2026-10')) {
      return { body: { month: '2026-10', line: wageLine } };
    }
    if (url.startsWith('/me/worker/wages')) {
      return { body: { month: '2026-09', line: null } };
    }
    return undefined;
  };
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((fullUrl: string, init: RequestInit) => {
      const url = fullUrl.replace(/^https?:\/\/[^/]+/, '');
      if (url === '/me') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(profile) });
      }
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      });
      const { status = 200, body } = handler(url, init) ?? { body: { items: [] } };
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

describe('month helpers', () => {
  it('recognizes yyyy-mm and names this month in Karachi', () => {
    expect(isMonth('2026-10')).toBe(true);
    for (const bad of ['', '2026-13', '2026-00', '2026-1', '26-10', '2026-10-01'])
      expect(isMonth(bad), bad).toBe(false);
    expect(currentMonth(new Date('2026-10-31T20:00:00Z'))).toBe('2026-11');
    expect(currentMonth(new Date('2026-10-25T10:00:00Z'))).toBe('2026-10');
  });
});

describe('the worker shell (BR-5)', () => {
  it('lands on attendance and offers nothing but the three own pages', async () => {
    open('/');
    expect(await screen.findByText('22/10/2026')).toBeInTheDocument();
    const menu = screen.getByRole('menu', { name: 'Main menu' });
    const links = within(menu)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(links).toEqual(['My attendance', 'My advances', 'My wages']);
    expect(screen.getByText(/Ali Raza/)).toBeInTheDocument();
    expect(calls.every((call) => call.url.startsWith('/me/worker/'))).toBe(true);
  });

  it('keeps the office pages closed on a direct address', async () => {
    open('/wages/periods');
    expect(await screen.findByText(/do not have permission|forbidden|403/i)).toBeInTheDocument();
    expect(calls.some((call) => call.url.startsWith('/wages/'))).toBe(false);
  });
});

describe('own attendance', () => {
  it('lists the approved days of the chosen month', async () => {
    open('/me/worker/attendance');
    expect(await screen.findByText('22/10/2026')).toBeInTheDocument();
    expect(screen.getByText('Present')).toBeInTheDocument();
    expect(screen.getByText('Half day')).toBeInTheDocument();
    expect(screen.getByText(/Overtime hours: 2.00/)).toBeInTheDocument();
    expect(calls[0]?.url).toMatch(/^\/me\/worker\/attendance\?month=\d{4}-\d{2}$/);
    expect(calls[0]?.url).not.toMatch(/worker_?id/i);
  });

  it('shows the empty message and refuses to ask for an unfinished month', async () => {
    handler = () => ({ body: { month: '2026-09', days: [] } });
    open('/me/worker/attendance');
    expect(await screen.findByText('No approved attendance for this month.')).toBeInTheDocument();
    const before = calls.length;
    const input = screen.getByLabelText('Month');
    await userEvent.clear(input);
    expect(calls.length).toBe(before);
  });

  it('explains a refused login', async () => {
    handler = () => ({ status: 403, body: { error: { code: 'no_worker_link', message: 'x' } } });
    open('/me/worker/attendance');
    expect(await screen.findByText(/not linked to a worker record/)).toBeInTheDocument();
  });
});

describe('own advances', () => {
  it('shows the balance and the recoveries', async () => {
    open('/me/worker/advances');
    expect(await screen.findByText('8,000.00')).toBeInTheDocument();
    expect(screen.getByText('2,000.00')).toBeInTheDocument();
    expect(screen.getByText('2026-10')).toBeInTheDocument();
  });

  it('says so when nothing was recovered', async () => {
    handler = () => ({ body: { balance: '0.00', recoveries: [] } });
    open('/me/worker/advances');
    expect(
      await screen.findByText('No advance recovery in the last twelve months.'),
    ).toBeInTheDocument();
  });

  it('shows the error of a failed load', async () => {
    handler = () => ({ status: 403, body: { error: { code: 'worker_left', message: 'x' } } });
    open('/me/worker/advances');
    expect(await screen.findByText(/access has ended/)).toBeInTheDocument();
  });
});

describe('own wages', () => {
  it('shows the line of an approved month, without any rate', async () => {
    const user = userEvent.setup();
    open('/me/worker/wages');
    await user.clear(await screen.findByLabelText('Month'));
    await user.type(screen.getByLabelText('Month'), '2026-10');
    expect(await screen.findByText('20,625.00')).toBeInTheDocument();
    expect(screen.getByText('Net pay')).toBeInTheDocument();
    expect(screen.getByText('2,000.00')).toBeInTheDocument();
    expect(screen.getByText('22.00')).toBeInTheDocument();
    expect(screen.queryByText(/rate/i)).not.toBeInTheDocument();
  });

  it('says the wages are not approved when the server sends no line', async () => {
    handler = () => ({ body: { month: '2026-09', line: null } });
    open('/me/worker/wages');
    expect(
      await screen.findByText('The wages for this month have not been approved yet.'),
    ).toBeInTheDocument();
  });
});

describe('the worker login control on the worker profile', () => {
  const users = [
    {
      id: 'u1',
      fullName: 'Ali Login',
      email: 'ali@example.test',
      roles: ['worker'],
      status: 'active',
    },
    {
      id: 'u2',
      fullName: 'Sana Super',
      email: 'sana@example.test',
      roles: ['worker', 'supervisor'],
      status: 'active',
    },
  ];
  let account: { userId: string } | null;

  beforeEach(() => {
    profile = profileOf(allPermissions);
    account = null;
    handler = (url, init) => {
      if (url === '/workforce/workers/w1') {
        return {
          body: {
            id: 'w1',
            code: 'WK-0001',
            fullName: 'Ali Raza',
            fatherName: null,
            cnic: null,
            phone: null,
            tradeCode: 'mason',
            employmentType: 'daily',
            joinedOn: '2026-01-01',
            leftOn: null,
            status: 'active',
            version: 1,
          },
        };
      }
      if (url === '/workforce/workers/w1/rates') return { body: [] };
      if (url === '/workforce/trades') return { body: [{ code: 'mason', name: 'Mason' }] };
      if (url === '/admin/users') return { body: { items: users } };
      if (url === '/admin/workers/w1/account' && init.method === 'GET') {
        return { body: { account: account === null ? null : { ...account, workerId: 'w1' } } };
      }
      if (url === '/admin/workers/w1/account' && init.method === 'PUT') {
        const body = JSON.parse(init.body as string) as {
          userId: string;
          confirmOtherRoles: boolean;
        };
        if (body.userId === 'u2' && !body.confirmOtherRoles) {
          return { status: 400, body: { error: { code: 'user_has_other_roles', message: 'x' } } };
        }
        account = { userId: body.userId };
        return { body: { userId: body.userId, workerId: 'w1' } };
      }
      if (url === '/admin/workers/w1/account' && init.method === 'DELETE') {
        account = null;
        return { status: 204, body: {} };
      }
      return undefined;
    };
  });

  it('links a worker-only login and then removes it', async () => {
    const user = userEvent.setup();
    open('/workforce/workers/w1');
    expect(await screen.findByText('No login is linked to this worker.')).toBeInTheDocument();
    const link = screen.getByRole('button', { name: 'Link login' });
    expect(link).toBeDisabled();

    await user.selectOptions(await screen.findByLabelText('Login'), 'u1');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(link);
    expect(await screen.findByText('The login was linked.')).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
      userId: 'u1',
      confirmOtherRoles: false,
    });
    expect(
      await screen.findByText('Linked login: Ali Login (ali@example.test)'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove login' }));
    expect(await screen.findByText('The login was removed.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('No login is linked to this worker.')).toBeInTheDocument(),
    );
  });

  it('asks the admin to confirm a login with other roles', async () => {
    const user = userEvent.setup();
    open('/workforce/workers/w1');
    await screen.findByRole('option', { name: /Sana Super/ });
    await user.selectOptions(screen.getByLabelText('Login'), 'u2');
    const link = screen.getByRole('button', { name: 'Link login' });
    expect(link).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(link).toBeEnabled();
    await user.click(link);
    expect(await screen.findByText('The login was linked.')).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
      userId: 'u2',
      confirmOtherRoles: true,
    });
  });

  it('shows the server answer when linking fails', async () => {
    const user = userEvent.setup();
    handler = ((previous) => (url: string, init: RequestInit) =>
      url === '/admin/workers/w1/account' && init.method === 'PUT'
        ? { status: 409, body: { error: { code: 'user_already_linked', message: 'x' } } }
        : previous(url, init))(handler);
    open('/workforce/workers/w1');
    await screen.findByRole('option', { name: /Ali Login/ });
    await user.selectOptions(screen.getByLabelText('Login'), 'u1');
    await user.click(screen.getByRole('button', { name: 'Link login' }));
    expect(await screen.findByText(/already linked to another worker/)).toBeInTheDocument();
  });

  it('shows the server answer when removing fails', async () => {
    const user = userEvent.setup();
    account = { userId: 'u1' };
    handler = ((previous) => (url: string, init: RequestInit) =>
      url === '/admin/workers/w1/account' && init.method === 'DELETE'
        ? { status: 404, body: { error: { code: 'account_not_found', message: 'x' } } }
        : previous(url, init))(handler);
    open('/workforce/workers/w1');
    await user.click(await screen.findByRole('button', { name: 'Remove login' }));
    expect(await screen.findByText('This worker has no login.')).toBeInTheDocument();
  });

  it('is hidden from those who may not manage logins', async () => {
    profile = profileOf(
      allPermissions.filter((permission) => permission !== workerportalPermissions.accountManage),
    );
    open('/workforce/workers/w1');
    expect(await screen.findByText('WK-0001')).toBeInTheDocument();
    expect(screen.queryByText('Worker login')).not.toBeInTheDocument();
  });
});
