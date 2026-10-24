import { importerPermissions } from '@emporium/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';

interface Call {
  url: string;
  method: string;
  body: unknown;
}
type Handler = (call: Call) => { status?: number; body?: unknown; text?: string };

let handler: Handler;
let permissions: string[];
const calls: Call[] = [];

const importers = {
  items: [
    { code: 'people', label: 'People (test)', dependsOn: [] },
    { code: 'dependent', label: 'Dependent (test)', dependsOn: ['people'] },
  ],
};
const batch = (over: object = {}) => ({
  id: 'b1',
  importerCode: 'people',
  fileName: 'people.csv',
  status: 'committed',
  rowCount: 2,
  errorCount: 0,
  dryRunAt: '2026-10-24T10:00:00Z',
  ...over,
});

const defaults: Handler = ({ url, method }) => {
  if (url === '/imports/importers') return { body: importers };
  if (url.startsWith('/imports/batches?')) return { body: { items: [] } };
  if (method === 'GET') return { text: 'file-content' };
  return { body: {} };
};

beforeEach(() => {
  calls.length = 0;
  permissions = allPermissions;
  handler = defaults;
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
      const call: Call = {
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      };
      calls.push(call);
      const { status = 200, body = {}, text } = handler(call);
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
        blob: () => Promise.resolve(new Blob([text ?? ''])),
      });
    }),
  );
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = () =>
  render(
    <AppProviders auth={fakeAuth()}>
      <MemoryRouter initialEntries={['/imports']}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

const choose = async (label: string) => {
  await userEvent.click(await screen.findByRole('combobox', { name: 'What to import' }));
  await userEvent.click(await screen.findByTitle(label));
};

const pickFile = async (content = 'Name,Amount\nA,1\n', name = 'people.csv') => {
  const input = screen.getByLabelText<HTMLInputElement>('File (.csv or .xlsx)');
  await userEvent.upload(input, new File([content], name, { type: 'text/csv' }));
};

describe('import page', () => {
  it('runs a dry run, shows the result and commits', async () => {
    handler = (call) => {
      if (call.url.endsWith('/dry-run')) {
        return {
          status: 201,
          body: { batchId: 'b1', status: 'dry_run_ok', rowCount: 2, errorCount: 0, errors: [] },
        };
      }
      if (call.url.endsWith('/commit')) return { body: batch() };
      return defaults(call);
    };
    open();
    await choose('People (test)');
    await pickFile();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    expect(
      await screen.findByText('Dry run passed: 2 rows are ready to import.'),
    ).toBeInTheDocument();
    const upload = calls.find((c) => c.url === '/imports/importers/people/dry-run');
    expect(upload?.body).toBeInstanceOf(FormData);
    await userEvent.click(screen.getByLabelText(/Import again/));
    await userEvent.click(screen.getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText('Imported 2 rows.')).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith('/commit'))?.body).toEqual({ force: true });
    expect(screen.queryByRole('button', { name: 'Commit import' })).not.toBeInTheDocument();
  }, 20_000);

  it('lists the problems of a failed dry run and downloads the report', async () => {
    handler = (call) => {
      if (call.url.endsWith('/dry-run')) {
        return {
          status: 201,
          body: {
            batchId: 'b2',
            status: 'dry_run_failed',
            rowCount: 3,
            errorCount: 250,
            errors: [{ rowNo: 3, column: 'Amount', message: 'Must be a plain decimal number' }],
          },
        };
      }
      return defaults(call);
    };
    open();
    await choose('People (test)');
    await pickFile();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    expect(
      await screen.findByText('Dry run found 250 problems. Nothing was imported.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Showing the first 1 of 250 problems. Download the report for all.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Must be a plain decimal number')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commit import' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download error report' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/imports/batches/b2/errors.csv')).toBe(true),
    );
  });

  it('asks for a file before the dry run', async () => {
    open();
    await choose('People (test)');
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    expect(await screen.findByText('Choose a file first')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/dry-run'))).toBe(false);
  });

  it('downloads both templates and shows the dependency note', async () => {
    open();
    await choose('Dependent (test)');
    expect(screen.getByText('Import first: people')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV template' }));
    await userEvent.click(screen.getByRole('button', { name: 'Download Excel template' }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/imports/importers/dependent/template?format=csv')).toBe(
        true,
      );
      expect(calls.some((c) => c.url === '/imports/importers/dependent/template?format=xlsx')).toBe(
        true,
      );
    });
  });

  it('explains known errors, falls back to the server message and shows generic failures', async () => {
    let code = 'duplicate_file';
    handler = (call) => {
      if (call.url.endsWith('/dry-run')) {
        return { status: 400, body: { error: { code, message: 'Server words' } } };
      }
      return defaults(call);
    };
    open();
    await choose('People (test)');
    await pickFile();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    expect(await screen.findByText('This file was already imported.')).toBeInTheDocument();
    code = 'something_else';
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    expect(await screen.findByText('Server words')).toBeInTheDocument();
  });

  it('shows the commit failure message', async () => {
    handler = (call) => {
      if (call.url.endsWith('/dry-run')) {
        return {
          status: 201,
          body: { batchId: 'b1', status: 'dry_run_ok', rowCount: 1, errorCount: 0, errors: [] },
        };
      }
      if (call.url.endsWith('/commit')) {
        return { status: 422, body: { error: { code: 'import_failed', message: 'x' } } };
      }
      return defaults(call);
    };
    open();
    await choose('People (test)');
    await pickFile();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText('The import failed and nothing was saved.')).toBeInTheDocument();
  });

  it('shows a plain error when the request itself fails', async () => {
    open();
    await choose('People (test)');
    await pickFile();
    vi.mocked(fetch).mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });

  it('lists previous imports with a report link for batches that had problems', async () => {
    handler = (call) =>
      call.url.startsWith('/imports/batches?')
        ? {
            body: {
              items: [
                batch(),
                batch({ id: 'b9', fileName: 'bad.csv', status: 'dry_run_failed', errorCount: 4 }),
              ],
            },
          }
        : defaults(call);
    open();
    expect(await screen.findByText('bad.csv')).toBeInTheDocument();
    expect(screen.getByText('Imported')).toBeInTheDocument();
    const report = screen.getByRole('button', { name: /Download error report bad.csv/ });
    expect(screen.getAllByRole('button', { name: /Download error report/ })).toHaveLength(1);
    await userEvent.click(report);
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/imports/batches/b9/errors.csv')).toBe(true),
    );
  });

  it('shows load errors', async () => {
    handler = () => ({ status: 500, body: {} });
    open();
    expect((await screen.findAllByText('Could not load data')).length).toBeGreaterThan(0);
  });

  it('lets a read-only user see the history but not import', async () => {
    permissions = [importerPermissions.batchRead];
    open();
    expect(await screen.findByText('Previous imports')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'What to import' })).not.toBeInTheDocument();
  });

  it('shows the no-access page without the read permission', async () => {
    permissions = [];
    open();
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });
});
