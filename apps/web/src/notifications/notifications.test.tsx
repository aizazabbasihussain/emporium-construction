import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@emporium/shared';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { templateKey } from './api';

interface Call {
  url: string;
  method: string;
}
type Handler = (call: Call) => { status?: number; body?: unknown };

let handler: Handler;
let permissions: string[];
let unread: number;
const calls: Call[] = [];

const item = (id: string, template: string, readAt: string | null = null) => ({
  id,
  template,
  data: { docType: 'purchase_order', amount: '250000.00' },
  readAt,
  createdAt: '2026-10-25T10:00:00.000Z',
});

const defaults: Handler = ({ url, method }) => {
  if (url === '/notifications') {
    return {
      body: {
        items: [
          item('n1', 'approval.requested'),
          item('n2', 'approval.approved', '2026-10-25T11:00:00.000Z'),
          item('n3', 'lead.assigned'),
        ],
        unread,
      },
    };
  }
  if (method === 'POST') return { body: { updated: 2 } };
  return {};
};

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = defaults;
  unread = 2;
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url === '/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(profileOf(permissions)),
        });
      }
      const call: Call = { url, method: init.method ?? 'GET' };
      calls.push(call);
      const { status = 200, body = {} } = handler(call);
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

describe('notification bell', () => {
  it('shows the unread count in the header and links to the list', async () => {
    open('/');
    const link = await screen.findByRole('link', { name: 'Notifications (2 unread)' });
    expect(link).toHaveAttribute('href', '/notifications');
  });

  it('is absent without the permission and then makes no request', async () => {
    permissions = [];
    open('/');
    await screen.findByText(/Welcome/);
    expect(screen.queryByRole('link', { name: /Notifications/ })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === '/notifications')).toBe(false);
  });

  it('counts zero while the first answer is missing', async () => {
    handler = ({ url }) => (url === '/notifications' ? { status: 500, body: {} } : {});
    open('/');
    expect(
      await screen.findByRole('link', { name: 'Notifications (0 unread)' }),
    ).toBeInTheDocument();
  });
});

describe('notifications page', () => {
  it('renders each template in words, falling back for an unknown one', async () => {
    open('/notifications');
    expect(
      await screen.findByText('purchase_order of 250,000.00 is waiting for your approval.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Your purchase_order of 250,000.00 was approved.')).toBeInTheDocument();
    expect(screen.getByText('You have a new notification.')).toBeInTheDocument();
  });

  it('marks one notification as read and offers it only for unread ones', async () => {
    open('/notifications');
    const buttons = await screen.findAllByRole('button', { name: 'Mark as read' });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0] as HTMLElement);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/notifications/n1/read')).toBe(
        true,
      ),
    );
  });

  it('marks everything as read', async () => {
    open('/notifications');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/notifications/read-all')).toBe(
        true,
      ),
    );
  });

  it('disables mark-all when nothing is unread and shows the empty message', async () => {
    unread = 0;
    handler = ({ url }) => (url === '/notifications' ? { body: { items: [], unread: 0 } } : {});
    open('/notifications');
    expect(await screen.findByText('You have no notifications.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });

  it('shows an error when saving fails', async () => {
    handler = (call) => (call.method === 'POST' ? { status: 500, body: {} } : defaults(call));
    open('/notifications');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    expect(await screen.findByText(/Could not save/)).toBeInTheDocument();
  });

  it('shows an error when the list cannot be loaded', async () => {
    handler = () => ({ status: 500, body: {} });
    open('/notifications');
    expect(await screen.findByText(en.common.loadError)).toBeInTheDocument();
  });
});

describe('templateKey', () => {
  it('maps approval templates and falls back for others', () => {
    expect(templateKey('approval.rejected')).toBe('notifications.templates.approvalRejected');
    expect(templateKey('lead.assigned')).toBe('notifications.unknown');
  });
});
