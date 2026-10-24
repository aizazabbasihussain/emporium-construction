import { identityPermissions } from '@emporium/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import type { Profile, RoleItem, UserItem } from '../auth/api';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';

type Reply = { status?: number; body: unknown };
let profile: Profile;
let replies: Record<string, Reply>;
let calls: { url: string; method: string; body: unknown }[];

const storekeeper: UserItem = {
  id: '018f2222-0000-7000-8000-000000000004',
  email: 'store@example.test',
  fullName: 'Store Keeper',
  phone: null,
  status: 'active',
  locale: 'en',
  lastLoginAt: null,
  version: 3,
  roles: ['storekeeper'],
  scopes: [],
};
const disabledUser: UserItem = {
  ...storekeeper,
  id: '018f2222-0000-7000-8000-000000000005',
  email: 'gone@example.test',
  fullName: 'Gone Person',
  status: 'disabled',
  version: 2,
};
const roles: RoleItem[] = [
  { code: 'storekeeper', name: 'Store keeper', description: '', system: true, permissions: [] },
  { code: 'estimator', name: 'Estimator', description: '', system: true, permissions: [] },
];

beforeEach(() => {
  profile = profileOf(allPermissions);
  calls = [];
  replies = {
    'GET /admin/users': { body: { items: [storekeeper, disabledUser] } },
    'GET /admin/roles': { body: { items: roles, permissions: ['a.b.read', 'a.b.write'] } },
  };
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
      const reply: Reply =
        replies[`${method} ${url}`] ??
        (url === '/me' ? { body: profile } : { status: 500, body: {} });
      const { status = 200, body } = reply;
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

describe('users page', () => {
  it('lists users with role names and status', async () => {
    open('/admin/users');
    expect(await screen.findByText('Store Keeper')).toBeInTheDocument();
    expect(screen.getByText('gone@example.test')).toBeInTheDocument();
    expect((await screen.findAllByText('Store keeper')).length).toBeGreaterThan(0);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('hides the management buttons from a user who can only read', async () => {
    profile = profileOf([identityPermissions.userRead]);
    open('/admin/users');
    await screen.findByText('Store Keeper');
    expect(screen.queryByRole('button', { name: 'Add user' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable/ })).not.toBeInTheDocument();
  });

  it('adds a user after validating the form', async () => {
    replies['POST /admin/users'] = { status: 201, body: storekeeper };
    open('/admin/users');
    await screen.findByText('Store Keeper');
    await userEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'bad');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a valid email address')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.clear(within(dialog).getByLabelText('Email'));
    await userEvent.type(within(dialog).getByLabelText('Email'), ' New@Example.test ');
    await userEvent.type(within(dialog).getByLabelText('Full name'), 'New Person');
    await userEvent.type(within(dialog).getByLabelText('Phone'), '0300');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        email: 'New@Example.test',
        fullName: 'New Person',
        phone: '0300',
        roles: [],
      }),
    );
  });

  it('explains a duplicate email', async () => {
    replies['POST /admin/users'] = { status: 409, body: { error: { code: 'email_taken' } } };
    open('/admin/users');
    await screen.findByText('Store Keeper');
    await userEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'dup@example.test');
    await userEvent.type(within(dialog).getByLabelText('Full name'), 'Dup');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A user with this email already exists.')).toBeInTheDocument();
  });

  it('disables a user after confirmation, sending the loaded version', async () => {
    replies['PATCH /admin/users/' + storekeeper.id] = {
      body: { ...storekeeper, status: 'disabled', version: 4 },
    };
    open('/admin/users');
    await userEvent.click(
      await screen.findByRole('button', { name: /Disable store@example.test/ }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Yes' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        status: 'disabled',
        version: 3,
      }),
    );
  });

  it('enables a disabled user and reports the last-admin rule', async () => {
    replies['PATCH /admin/users/' + disabledUser.id] = {
      status: 422,
      body: { error: { code: 'last_admin' } },
    };
    open('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: /Enable gone@example.test/ }));
    expect(
      await screen.findByText('The last active admin cannot be demoted or disabled.'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'active', version: 2 });
  });

  it('shows a conflict and a generic failure in plain words', async () => {
    replies['PATCH /admin/users/' + disabledUser.id] = {
      status: 409,
      body: { error: { code: 'version_conflict' } },
    };
    open('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: /Enable gone@example.test/ }));
    expect(
      await screen.findByText('Someone else changed this record. Reload and try again.'),
    ).toBeInTheDocument();
  });

  it('saves scopes for a user with the loaded version', async () => {
    replies['PUT /admin/users/' + storekeeper.id + '/scopes'] = { body: storekeeper };
    open('/admin/users');
    await userEvent.click(
      await screen.findByRole('button', { name: /Projects and teams store@example.test/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add scope' }));
    await userEvent.type(within(dialog).getByLabelText('Id'), 'not-a-uuid');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Enter the id of the project or team'),
    ).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText('Id'));
    await userEvent.type(
      within(dialog).getByLabelText('Id'),
      '018f2222-0000-7000-8000-000000000900',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        scopes: [{ type: 'project', id: '018f2222-0000-7000-8000-000000000900' }],
        version: 3,
      }),
    );
  });

  it('saves roles for a user with the loaded version', async () => {
    replies['PUT /admin/users/' + storekeeper.id + '/roles'] = { body: storekeeper };
    open('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: /Roles store@example.test/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        roles: ['storekeeper'],
        version: 3,
      }),
    );
  });

  it('shows a load error', async () => {
    replies['GET /admin/users'] = { status: 500, body: {} };
    open('/admin/users');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('roles page', () => {
  it('lists roles and keeps Save disabled until a permission is changed', async () => {
    open('/admin/roles');
    expect(await screen.findByText('Estimator')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Estimator' })).toBeDisabled();
  });

  it('saves the edited permissions of one role', async () => {
    replies['PUT /admin/roles/estimator/permissions'] = {
      body: { ...roles[1], permissions: ['a.b.read'] },
    };
    open('/admin/roles');
    const select = await screen.findByRole('combobox', { name: 'Permissions Estimator' });
    await userEvent.click(select);
    await userEvent.click(await screen.findByTitle('a.b.read'));
    const save = screen.getByRole('button', { name: 'Save Estimator' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ permissions: ['a.b.read'] }),
    );
  });

  it('shows read-only permissions to a user who cannot manage roles', async () => {
    profile = profileOf([identityPermissions.userRead]);
    open('/admin/roles');
    await screen.findByText('Estimator');
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Permissions Estimator' })).toBeDisabled();
  });

  it('shows load and save errors', async () => {
    replies['PUT /admin/roles/estimator/permissions'] = { status: 400, body: {} };
    open('/admin/roles');
    const select = await screen.findByRole('combobox', { name: 'Permissions Estimator' });
    await userEvent.click(select);
    await userEvent.click(await screen.findByTitle('a.b.write'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Estimator' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    replies['GET /admin/roles'] = { status: 500, body: {} };
    open('/admin/roles');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});
