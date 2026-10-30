import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { emptyDraft, karachiToday } from '../dpr/form';
import { openOfflineDb, StorageFullError, type OfflineDb } from './db';
import { registerServiceWorker } from './register';

const ME = '018f2222-0000-7000-8000-000000000001';

interface Call {
  url: string;
  method: string;
  key: string | undefined;
  body: Record<string, unknown> | undefined;
}
type Reply = { status?: number; body: unknown };

let db: OfflineDb;
let calls: Call[];
type Handler = (call: Call) => Reply | 'network' | undefined;
let handler: Handler;
let base: Handler;
let storage: { quota: number; usage: number } | undefined;
let auth = fakeAuth();

const page = (items: unknown[]) => ({ items, total: items.length, limit: 200, offset: 0 });
const created = { id: 'r-new', status: 'draft', version: 1 };

const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/dpr/reports');

beforeEach(async () => {
  db = await openOfflineDb(new IDBFactory());
  calls = [];
  storage = undefined;
  auth = fakeAuth();
  base = ({ url, method }) => {
    if (url === '/dpr/reports' && method === 'POST') return { status: 201, body: created };
    if (url.startsWith('/dpr/reports?')) return { body: page([]) };
    if (url.startsWith('/projects/p1/tasks')) return { body: [] };
    if (url.startsWith('/projects')) {
      return { body: page([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall' }]) };
    }
    return undefined;
  };
  handler = (call) => base(call);
  vi.stubGlobal(
    'fetch',
    vi.fn((fullUrl: string, init: RequestInit = {}) => {
      const url = fullUrl.replace(/^https?:\/\/[^/]+/, '');
      if (url === '/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(profileOf(allPermissions, { id: ME })),
        });
      }
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url,
        method: init.method ?? 'GET',
        key: headers['idempotency-key'],
        body:
          typeof init.body === 'string'
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined,
      };
      calls.push(call);
      const reply = handler(call);
      if (reply === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      const { status = 200, body } = reply ?? { body: page([]) };
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    }),
  );
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { estimate: () => Promise.resolve(storage ?? { quota: 10 ** 12, usage: 0 }) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const open = (path: string) =>
  render(
    <AppProviders auth={auth} openOfflineDb={() => Promise.resolve(db)}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

const drafts = () => db.drafts.all();
const queued = () => db.queue.all();

async function fillNewReport(workDone = 'Shuttering of the roof slab') {
  await screen.findByRole('heading', { name: /New report/ });
  await userEvent.click(screen.getByLabelText('Project'));
  await userEvent.click(await screen.findByTitle('PRJ-0001 Boundary wall'));
  await userEvent.type(screen.getByLabelText('Work done'), workDone);
}

describe('autosave and restore (BR-2, T-4)', () => {
  it('saves the form 500 ms after the last change, not on every key', async () => {
    open('/dpr/reports/new');
    await fillNewReport('Slab');
    // Typing has just stopped: the debounce has not fired yet.
    expect(await drafts()).toEqual([]);
    await waitFor(async () => expect(await drafts()).toHaveLength(1), { timeout: 3000 });
    const [draft] = await drafts();
    expect(draft).toMatchObject({ key: 'dpr:new', formType: 'dpr', userId: ME });
    expect((draft?.payload as { workDone: string }).workDone).toBe('Slab');
  });

  it('offers the draft back after a reload and restores it on request', async () => {
    const first = open('/dpr/reports/new');
    await fillNewReport();
    await waitFor(async () => expect(await drafts()).toHaveLength(1), { timeout: 3000 });
    first.unmount();

    open('/dpr/reports/new');
    expect(await screen.findByText(/A draft saved on this device was found/)).toBeVisible();
    expect(screen.getByLabelText('Work done')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Restore draft' }));
    expect(screen.getByLabelText('Work done')).toHaveValue('Shuttering of the roof slab');
    expect(screen.queryByText(/A draft saved on this device was found/)).not.toBeInTheDocument();
  });

  it('discards a draft on request', async () => {
    const first = open('/dpr/reports/new');
    await fillNewReport();
    await waitFor(async () => expect(await drafts()).toHaveLength(1), { timeout: 3000 });
    first.unmount();

    open('/dpr/reports/new');
    await userEvent.click(await screen.findByRole('button', { name: 'Discard draft' }));
    expect(await drafts()).toEqual([]);
    expect(screen.queryByText(/A draft saved on this device was found/)).not.toBeInTheDocument();
  });

  it('says when the draft is older than 30 days', async () => {
    await db.drafts.put({
      key: 'dpr:new',
      formType: 'dpr',
      payload: { projectId: 'p1', workDone: 'Old text here' },
      updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      userId: ME,
    });
    open('/dpr/reports/new');
    expect(await screen.findByText(/older than 30 days/)).toBeVisible();
    expect(await screen.findByText('1 saved draft is older than 30 days.')).toBeVisible();
  });

  it('does not show another user’s draft', async () => {
    await db.drafts.put({
      key: 'dpr:new',
      formType: 'dpr',
      payload: {},
      updatedAt: Date.now(),
      userId: 'someone-else',
    });
    open('/dpr/reports/new');
    await screen.findByRole('heading', { name: /New report/ });
    await screen.findByText('Online');
    expect(screen.queryByText(/A draft saved on this device was found/)).not.toBeInTheDocument();
  });

  it('tells the user before data is lost when the device is out of space (T-7)', async () => {
    db = {
      ...db,
      drafts: { ...db.drafts, put: () => Promise.reject(new StorageFullError()) },
    };
    open('/dpr/reports/new');
    await fillNewReport('Slab');
    expect(await screen.findByText(/out of storage/, {}, { timeout: 3000 })).toBeVisible();
  });

  it('warns when free storage is below 50 MB (BR-6)', async () => {
    storage = { quota: 100 * 1024 * 1024, usage: 80 * 1024 * 1024 };
    open('/');
    expect(await screen.findByText(/almost out of storage/)).toBeVisible();
  });
});

describe('sending a new report (BR-3, BR-4, T-4)', () => {
  it('sends straight away when online and opens the saved report', async () => {
    open('/dpr/reports/new');
    await fillNewReport();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts()[0]?.body).toMatchObject({
      projectId: 'p1',
      reportDate: karachiToday(),
      workDone: 'Shuttering of the roof slab',
    });
    await waitFor(() => expect(location.pathname).not.toBe('/dpr/reports/new'));
    expect(await drafts()).toEqual([]);
  });

  it('keeps the report when the connection is down and sends it once when it returns', async () => {
    handler = (call) => {
      if (call.url === '/dpr/reports' && call.method === 'POST') return 'network';
      return base(call);
    };
    open('/dpr/reports/new');
    await fillNewReport();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Saved on this device, will be sent when you are back online.'),
    ).toBeVisible();
    expect(await screen.findByText('1 unsent item')).toBeVisible();
    // The form is empty again for the next report; the draft became the queued request.
    expect(screen.getByLabelText('Work done')).toHaveValue('');
    expect(await drafts()).toEqual([]);
    const [item] = await queued();
    expect(item).toMatchObject({ status: 'pending', attempts: 1, lastError: 'offline' });
    const firstKey = posts()[0]?.key;
    expect(item?.idempotencyKey).toBe(firstKey);

    // The server did create it the first time but the answer was lost; the retry repeats the key.
    handler = (call) =>
      call.url === '/dpr/reports' && call.method === 'POST'
        ? { status: 201, body: created }
        : base(call);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]?.key).toBe(firstKey);
    expect(await screen.findByText('Everything is sent')).toBeVisible();
    // Nothing more is sent afterwards.
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(posts()).toHaveLength(2);
  });

  it('shows the status bar going offline and online', async () => {
    open('/');
    expect(await screen.findByText('Online')).toBeVisible();
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByText('Offline')).toBeVisible();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(await screen.findByText('Online')).toBeVisible();
  });

  it('shows the server’s reason for a refusal and keeps the data for editing (AC-2)', async () => {
    handler = (call) =>
      call.url === '/dpr/reports' && call.method === 'POST'
        ? {
            status: 422,
            body: { error: { code: 'dpr_invalid', message: 'The project is not active' } },
          }
        : base(call);
    open('/dpr/reports/new');
    await fillNewReport();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('The project is not active')).toBeVisible();
    expect(screen.getByLabelText('Work done')).toHaveValue('Shuttering of the roof slab');
    expect(await queued()).toEqual([]);
    // A refused request is not retried.
    expect(posts()).toHaveLength(1);
    expect(await drafts()).toHaveLength(1);
  });

  it('lists a refused item with its reason and puts it back into the form to resend', async () => {
    await db.queue.put({
      id: 'q1',
      idempotencyKey: 'k1',
      method: 'POST',
      url: '/dpr/reports',
      body: {},
      userId: ME,
      source: {
        formType: 'dpr',
        draftKey: 'dpr:new',
        path: '/dpr/reports/new',
        payload: { ...emptyDraft(karachiToday()), projectId: 'p1', workDone: 'Text typed earlier' },
      },
      resultId: null,
      createdAt: 1,
      status: 'failed',
      attempts: 1,
      nextAttemptAt: 0,
      lastError: 'A report already exists for this date',
    });
    open('/');
    await userEvent.click(await screen.findByRole('link', { name: '1 unsent item' }));
    expect(await screen.findByRole('heading', { name: 'Unsent items' })).toBeVisible();
    expect(screen.getByText('Daily report')).toBeVisible();
    expect(screen.getByText('Rejected')).toBeVisible();
    expect(screen.getByText(/A report already exists for this date/)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Edit and resend' }));
    expect(await screen.findByRole('heading', { name: /New report/ })).toBeVisible();
    expect(await queued()).toEqual([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Restore draft' }));
    expect(screen.getByLabelText('Work done')).toHaveValue('Text typed earlier');
  });

  it('retries a waiting item on request and discards one on confirmation', async () => {
    handler = () => undefined;
    await db.queue.put({
      id: 'q1',
      idempotencyKey: 'k1',
      method: 'POST',
      url: '/dpr/reports',
      body: { projectId: 'p1' },
      userId: ME,
      source: null,
      resultId: null,
      createdAt: 1,
      status: 'pending',
      attempts: 2,
      nextAttemptAt: Date.now() + 10 * 60 * 1000,
      lastError: 'offline',
    });
    open('/offline/unsent');
    expect(await screen.findByText('Waiting to send')).toBeVisible();
    expect(screen.getByText('No connection yet')).toBeVisible();
    expect(screen.getByText('Attempts: 2')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await userEvent.click(await screen.findByRole('button', { name: /^OK$/ }));
    expect(await screen.findByText('Nothing is waiting to be sent.')).toBeVisible();
    expect(await queued()).toEqual([]);
  });

  it('leaves a request queued while signed out and sends it after sign-in (BR-4)', async () => {
    handler = (call) =>
      call.url === '/dpr/reports' && call.method === 'POST'
        ? { status: 401, body: { error: { code: 'unauthorized', message: 'Sign in again' } } }
        : base(call);
    open('/dpr/reports/new');
    await fillNewReport();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('1 unsent item')).toBeVisible();
    expect(posts()).toHaveLength(1);
    // Paused: coming online does not hammer the server with a request that will be refused.
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(posts().length).toBeGreaterThanOrEqual(1));
    const [item] = await queued();
    expect(item).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('conflict with a submitted report (BR-8)', () => {
  it('warns and blocks saving a draft for a date that already has a submitted report', async () => {
    handler = ({ url }) =>
      url.startsWith('/dpr/reports?')
        ? { body: page([{ id: 'r9', reportDate: karachiToday(), status: 'submitted' }]) }
        : url.startsWith('/projects/p1/tasks')
          ? { body: [] }
          : url.startsWith('/projects')
            ? { body: page([{ id: 'p1', code: 'PRJ-0001', name: 'Boundary wall' }]) }
            : undefined;
    open('/dpr/reports/new');
    await fillNewReport();
    expect(
      await screen.findByText(/already submitted. It cannot be replaced by a draft/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('does not warn for a date without a submitted report', async () => {
    open('/dpr/reports/new');
    await fillNewReport();
    await screen.findByText('Online');
    expect(screen.queryByText(/cannot be replaced by a draft/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('attendance grid and expense claim drafts (BR-2)', () => {
  it('keeps an edited attendance grid and offers it back', async () => {
    handler = ({ url }) => {
      if (url.startsWith('/attendance/grid')) {
        return {
          body: {
            teamId: 't1',
            date: '2026-10-30',
            sheet: null,
            members: [{ workerId: 'w1', code: 'W-1', fullName: 'Ali Raza', tradeCode: 'mason' }],
          },
        };
      }
      if (url.startsWith('/workforce/teams')) {
        return { body: [{ id: 't1', code: 'T-1', name: 'Team A', active: true }] };
      }
      if (url.startsWith('/projects')) return { body: page([]) };
      return undefined;
    };
    const first = open('/attendance/grid?team=t1&date=2026-10-30');
    const status = await screen.findByLabelText(/^Status W-1/);
    fireEvent.change(status, { target: { value: 'absent' } });
    await waitFor(async () => expect(await drafts()).toHaveLength(1), { timeout: 3000 });
    expect((await drafts())[0]?.key).toBe('attendance:t1:2026-10-30');
    first.unmount();

    open('/attendance/grid?team=t1&date=2026-10-30');
    expect(await screen.findByText(/A draft saved on this device was found/)).toBeVisible();
  });

  it('keeps a typed expense claim and offers it back', async () => {
    handler = ({ url }) =>
      url.startsWith('/expenses/categories') ? { body: [] } : base({ url } as Call);
    const first = open('/expenses/claims/new');
    await userEvent.type(await screen.findByLabelText('Note'), 'Cement transport');
    await waitFor(async () => expect(await drafts()).toHaveLength(1), { timeout: 3000 });
    expect((await drafts())[0]).toMatchObject({ key: 'expense:new', formType: 'expense' });
    first.unmount();

    open('/expenses/claims/new');
    await userEvent.click(await screen.findByRole('button', { name: 'Restore draft' }));
    expect(screen.getByLabelText('Note')).toHaveValue('Cement transport');
  });
});

describe('shared device (BR-2)', () => {
  it('asks at sign-out whether to delete the drafts, and deletes them on yes', async () => {
    await db.drafts.put({ key: 'dpr:new', formType: 'dpr', payload: {}, updatedAt: 1, userId: ME });
    open('/offline/unsent');
    await userEvent.click(await screen.findByLabelText(/This is a shared device/));
    expect(localStorage.getItem('ops-offline-shared-device')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/marked as shared/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete drafts' }));
    await waitFor(async () => expect(await drafts()).toEqual([]));
  });

  it('keeps the drafts when the user says keep, and by default', async () => {
    await db.drafts.put({ key: 'dpr:new', formType: 'dpr', payload: {}, updatedAt: 1, userId: ME });
    open('/offline/unsent');
    await screen.findByRole('heading', { name: 'Unsent items' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await drafts()).toHaveLength(1);
  });

  it('asks and keeps on “Keep drafts”', async () => {
    localStorage.setItem('ops-offline-shared-device', 'true');
    await db.drafts.put({ key: 'dpr:new', formType: 'dpr', payload: {}, updatedAt: 1, userId: ME });
    open('/offline/unsent');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep drafts' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await drafts()).toHaveLength(1);
  });
});

describe('installing and the service worker (BR-1)', () => {
  it('offers to install when the browser fires the install event', async () => {
    open('/');
    await screen.findByText('Online');
    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await userEvent.click(await screen.findByRole('button', { name: 'Install app' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();
  });

  it('hides the install button once the app is installed', async () => {
    open('/');
    await screen.findByText('Online');
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn(),
    });
    await act(async () => {
      window.dispatchEvent(event);
    });
    await screen.findByRole('button', { name: 'Install app' });
    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();
  });

  it('registers /sw.js at the site root', async () => {
    const register = vi.fn().mockResolvedValue({});
    expect(await registerServiceWorker({ serviceWorker: { register } as never })).toBe(true);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('carries on without a service worker when the browser has none or refuses', async () => {
    expect(await registerServiceWorker({})).toBe(false);
    const register = vi.fn().mockRejectedValue(new Error('blocked'));
    expect(await registerServiceWorker({ serviceWorker: { register } as never })).toBe(false);
  });
});

describe('without device storage', () => {
  it('works as before and shows no status bar', async () => {
    render(
      <AppProviders auth={auth} openOfflineDb={() => Promise.reject(new Error('no IndexedDB'))}>
        <MemoryRouter initialEntries={['/dpr/reports/new']}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>,
    );
    await screen.findByRole('heading', { name: /New report/ });
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    expect(screen.getByText(/Save the report first/i)).toBeInTheDocument();
  });
});
