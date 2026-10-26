import { identityPermissions, platformPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from './App';
import type { Profile } from './auth/api';
import { i18n } from './i18n';
import { allPermissions, fakeAuth, profileOf, type FakeAuth } from './test-utils';

type Reply = { status?: number; body: unknown };
let profile: Profile;
let replies: Record<string, Reply>;
let calls: { url: string; method: string; body: unknown; authorization: string | undefined }[];

beforeEach(() => {
  profile = profileOf(allPermissions);
  replies = {};
  calls = [];
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      calls.push({
        url,
        method,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        authorization: (init.headers as Record<string, string>).authorization,
      });
      const reply: Reply =
        replies[`${method} ${url}`] ??
        (url === '/me' && method === 'GET'
          ? { body: profile }
          : url === '/me' && method === 'PATCH'
            ? {
                body: {
                  ...profile,
                  ...JSON.parse(init.body as string),
                  version: profile.version + 1,
                },
              }
            : { status: 500, body: {} });
      const { status = 200, body } = reply;
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

const open = (path: string, auth: FakeAuth = fakeAuth()) =>
  render(
    <AppProviders auth={auth}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

describe('web shell (T-8)', () => {
  it('renders the app title from the shared English keys after loading the profile', async () => {
    open('/');
    expect(
      await screen.findByRole('heading', { name: 'Emporium Construction Operations' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Construction operations system')).toBeInTheDocument();
    expect(screen.getByText('Welcome, Test Person')).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ url: '/me', authorization: 'Bearer test-token' });
  });

  it('shows only the navigation items the user may open (BR-10)', async () => {
    profile = profileOf([identityPermissions.userRead, platformPermissions.auditRead]);
    open('/');
    const menu = await screen.findByRole('menu');
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).toEqual(['Home', 'Users', 'Roles', 'Audit log']);
  });

  it('shows every item to a user holding every permission', async () => {
    open('/');
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(26);
  });

  it('shows the 403 page on a direct URL without the permission', async () => {
    profile = profileOf([]);
    open('/admin/audit');
    expect(
      await screen.findByText('You do not have permission to open this page.'),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.url !== '/me')).toEqual([]);
  });

  it('shows the 404 page for an unknown address', async () => {
    open('/nowhere');
    expect(await screen.findByText('The page you asked for does not exist.')).toBeInTheDocument();
  });

  it('sends a signed-out visitor to the login page', async () => {
    open('/admin/users', fakeAuth({ signedIn: false }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('sends a visitor whose session has no account to the login page', async () => {
    replies['GET /me'] = { status: 401, body: { error: { code: 'unknown_user' } } };
    open('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('language switch (BR-11, AC-5)', () => {
  it('switches the layout direction to RTL for Urdu and back, and remembers the choice', async () => {
    open('/');
    await screen.findByRole('heading', { name: 'Emporium Construction Operations' });
    expect(document.documentElement.dir).toBe('ltr');

    await userEvent.click(screen.getByText('اردو'));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(document.documentElement.lang).toBe('ur');
    // No Urdu file yet, so every string falls back to its English key value (AC-5).
    expect(
      screen.getByRole('heading', { name: 'Emporium Construction Operations' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ locale: 'ur', version: 1 }),
    );

    await userEvent.click(screen.getByText('English'));
    await waitFor(() => expect(document.documentElement.dir).toBe('ltr'));
  });

  it('opens in the language stored on the account', async () => {
    profile = profileOf(allPermissions, { locale: 'ur' });
    open('/');
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
  });

  it('keeps the screen switched when saving the choice fails', async () => {
    replies['PATCH /me'] = { status: 500, body: {} };
    open('/');
    await screen.findByRole('heading', { name: 'Emporium Construction Operations' });
    await userEvent.click(screen.getByText('اردو'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(document.documentElement.dir).toBe('rtl');
  });
});

describe('login and logout (BR-9)', () => {
  const fillIn = async (password = 'secret') => {
    await userEvent.type(await screen.findByLabelText('Email'), ' person@example.test ');
    await userEvent.type(screen.getByLabelText('Password'), password);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  };

  it('signs in with email and password, then shows the home page', async () => {
    const auth = fakeAuth({ signedIn: false });
    open('/login', auth);
    await fillIn();
    expect(await screen.findByText('Welcome, Test Person')).toBeInTheDocument();
    expect(auth.token).toBe('test-token');
  });

  it('validates the form before calling anything', async () => {
    open('/login', fakeAuth({ signedIn: false }));
    await userEvent.type(await screen.findByLabelText('Email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('This field is required')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('reports a wrong password', async () => {
    open('/login', fakeAuth({ signedIn: false, wrongPassword: true }));
    await fillIn('wrong');
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument();
  });

  it('reports an account that is unknown or disabled and signs the session out', async () => {
    const auth = fakeAuth({ signedIn: false });
    replies['GET /me'] = { status: 403, body: { error: { code: 'user_disabled' } } };
    open('/login', auth);
    await fillIn();
    expect(
      await screen.findByText(/not set up for the system, or it is disabled/),
    ).toBeInTheDocument();
    expect(auth.token).toBeNull();
  });

  it('reports a server problem after sign-in', async () => {
    replies['GET /me'] = { status: 500, body: {} };
    open('/login', fakeAuth({ signedIn: false }));
    await fillIn();
    expect(await screen.findByText('Could not sign in. Try again.')).toBeInTheDocument();
  });

  it('redirects a signed-in user away from the login page', async () => {
    open('/login');
    expect(await screen.findByText('Welcome, Test Person')).toBeInTheDocument();
  });

  it('clears the session and the query cache on logout', async () => {
    const auth = fakeAuth();
    replies['GET /admin/users'] = { body: { items: [] } };
    replies['GET /admin/roles'] = { body: { items: [], permissions: [] } };
    open('/admin/users', auth);
    await screen.findByRole('heading', { name: 'Users' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(auth.token).toBeNull();
  });

  it('returns to the login page when the session ends elsewhere', async () => {
    const auth = fakeAuth();
    open('/', auth);
    await screen.findByText('Welcome, Test Person');
    auth.expire();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
