import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';

type Handler = (url: string, init: RequestInit) => { status?: number; body: unknown };
let handler: Handler;
const calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('crypto', { randomUUID: () => 'key-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const { status = 200, body } = handler(url, init);
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = (path: string) =>
  render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

describe('audit page', () => {
  it('lists entries and filters by entity', async () => {
    handler = () => ({
      body: {
        items: [
          {
            id: '1',
            at: '2026-10-24T10:05:00Z',
            actor_user_id: 'u1',
            action: 'invoice.issue',
            entity_type: 'invoice',
            entity_id: 'INV-2026-0001',
            request_id: 'r1',
          },
        ],
      },
    });
    open('/admin/audit');
    expect(await screen.findByText('invoice.issue')).toBeInTheDocument();
    expect(screen.getByText('24/10/2026 10:05')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Entity type'), ' invoice ');
    await userEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() => expect(calls.at(-1)?.url).toBe('/admin/audit?entityType=invoice'));
  });

  it('shows an error when loading fails', async () => {
    handler = () => ({ status: 500, body: {} });
    open('/admin/audit');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('settings page', () => {
  const setting = { key: 'backdating_days', value: 3, description: 'd', version: 1 };

  it('saves the backdating allowance with the loaded version', async () => {
    handler = (_url, init) =>
      init.method === 'PUT' ? { body: { ...setting, value: 5, version: 2 } } : { body: setting };
    open('/admin/settings');
    const input = await screen.findByLabelText('Backdating allowance (days)');
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ value: 5, version: 1 });
  });

  it('requires a value and does not call the API when empty', async () => {
    handler = () => ({ body: setting });
    open('/admin/settings');
    const input = await screen.findByLabelText('Backdating allowance (days)');
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('This field is required')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('explains a version conflict', async () => {
    handler = (_url, init) =>
      init.method === 'PUT'
        ? { status: 409, body: { error: { code: 'version_conflict', message: 'stale' } } }
        : { body: setting };
    open('/admin/settings');
    await screen.findByLabelText('Backdating allowance (days)');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(
      await screen.findByText('Someone else changed this setting. Reload and try again.'),
    ).toBeInTheDocument();
  });

  it('shows a generic save error and a load error', async () => {
    handler = (_url, init) =>
      init.method === 'PUT' ? { status: 500, body: {} } : { body: setting };
    open('/admin/settings');
    await screen.findByLabelText('Backdating allowance (days)');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    handler = () => ({ status: 500, body: {} });
    open('/admin/settings');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});

describe('number series page', () => {
  const invoice = {
    code: 'invoice',
    prefix: 'INV',
    padding: 4,
    resetYearly: true,
    gapless: true,
    startValue: 1,
    nextValue: 7,
    version: 3,
  };

  it('previews formats and edits an existing series with its version', async () => {
    handler = (_url, init) => ({ body: init.method === 'POST' ? invoice : { items: [invoice] } });
    open('/admin/number-series');
    expect(await screen.findByText('INV-YYYY-0007')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Edit invoice/ }));
    const prefix = screen.getByLabelText('Prefix');
    expect(prefix).toHaveValue('INV');
    await userEvent.clear(prefix);
    await userEvent.type(prefix, 'TAX');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      code: 'invoice',
      prefix: 'TAX',
      version: 3,
    });
  });

  it('validates a new series: code format, prefix and digits between 1 and 12', async () => {
    handler = () => ({ body: { items: [] } });
    open('/admin/number-series');
    await screen.findByText('Document number series');
    await userEvent.click(screen.getByRole('button', { name: /Add series/ }));
    await userEvent.type(screen.getByLabelText('Code'), 'Bad Code');
    const padding = screen.getByLabelText('Digits');
    await userEvent.clear(padding);
    await userEvent.type(padding, '20');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(
      await screen.findByText('Use lowercase letters, digits and underscores'),
    ).toBeInTheDocument();
    expect(screen.getByText('Digits must be between 1 and 12')).toBeInTheDocument();
    expect(screen.getAllByText('This field is required').length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows a non-yearly preview and a save error for a new series', async () => {
    const po = { ...invoice, code: 'po', prefix: 'PO', resetYearly: false, gapless: false };
    handler = (_url, init) =>
      init.method === 'POST'
        ? { status: 409, body: { error: { code: 'series_exists', message: 'exists' } } }
        : { body: { items: [po] } };
    open('/admin/number-series');
    expect(await screen.findByText('PO-0007')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Add series/ }));
    await userEvent.type(screen.getByLabelText('Code'), 'po');
    await userEvent.type(screen.getByLabelText('Prefix'), 'PO');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).not.toHaveProperty('version');
  });

  it('shows a load error', async () => {
    handler = () => ({ status: 500, body: {} });
    open('/admin/number-series');
    expect(await screen.findByText('Could not load data')).toBeInTheDocument();
  });
});
