import { filesPermissions } from '@emporium/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { AttachmentUploader } from './AttachmentUploader';
import type { CompressDeps } from './compress';

interface Call {
  url: string;
  method: string;
  body: unknown;
}
type Handler = (call: Call) => { status?: number; body?: unknown };

let handler: Handler;
let permissions: string[];
const calls: Call[] = [];

const attachment = (over: object = {}) => ({
  id: 'f1',
  entityType: 'test_doc',
  entityId: 'e1',
  fileName: 'wall.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 1000,
  caption: 'north wall',
  takenAt: null,
  version: 4,
  ...over,
});

const defaults: Handler = ({ url, method }) => {
  if (url.startsWith('/files?')) {
    return {
      body: {
        items: [
          attachment(),
          attachment({
            id: 'f2',
            fileName: 'plan.pdf',
            contentType: 'application/pdf',
            caption: null,
          }),
        ],
      },
    };
  }
  if (url.endsWith('/url'))
    return { body: { url: `https://files.test/${url.split('/')[2]}`, expiresAt: 'x' } };
  if (method === 'POST') return { status: 201, body: attachment({ id: 'f3' }) };
  return { body: attachment() };
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
      const { status = 200, body = {} } = handler(call);
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const compression = (): CompressDeps & { sizes: unknown[] } => {
  const sizes: unknown[] = [];
  return {
    sizes,
    measure: () => Promise.resolve({ width: 4000, height: 3000 }),
    encodeJpeg: (_file, size, quality) => {
      sizes.push({ size, quality });
      return Promise.resolve(new Blob([new Uint8Array(10)]));
    },
  };
};

const mount = (deps: CompressDeps = compression()) =>
  render(
    <AppProviders auth={fakeAuth()}>
      <AttachmentUploader entityType="test_doc" entityId="e1" compression={deps} />
    </AppProviders>,
  );

describe('attachment uploader', () => {
  it('lists attachments with a thumbnail for images', async () => {
    mount();
    expect(await screen.findByText('wall.jpg')).toBeInTheDocument();
    expect(screen.getByText('plan.pdf')).toBeInTheDocument();
    expect(screen.getByText('north wall')).toBeInTheDocument();
    const image = await screen.findByRole('img', { name: 'north wall' });
    expect(image).toHaveAttribute('src', 'https://files.test/f1');
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(calls.some((c) => c.url === '/files?entityType=test_doc&entityId=e1')).toBe(true);
  });

  it('shows an empty message', async () => {
    handler = ({ url }) => (url.startsWith('/files?') ? { body: { items: [] } } : {});
    mount();
    expect(await screen.findByText('No files attached yet.')).toBeInTheDocument();
  });

  it('compresses a photo to 1600 px at quality 0.7 before sending it (T-8)', async () => {
    const deps = compression();
    mount(deps);
    await userEvent.type(await screen.findByLabelText('Caption'), ' north wall ');
    const file = new File([new Uint8Array(5000)], 'IMG_0001.png', {
      type: 'image/png',
      lastModified: 1_700_000_000_000,
    });
    await userEvent.upload(screen.getByLabelText('Attach a file'), file);

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(deps.sizes).toEqual([{ size: { width: 1600, height: 1200 }, quality: 0.7 }]);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/files');
    const form = post?.body as FormData;
    expect(form.get('entityType')).toBe('test_doc');
    expect(form.get('entityId')).toBe('e1');
    expect(form.get('caption')).toBe('north wall');
    expect(form.get('takenAt')).toBe('2023-11-14T22:13:20.000Z');
    const sent = form.get('file') as File;
    expect(sent.name).toBe('IMG_0001.jpg');
    expect(sent.type).toBe('image/jpeg');
    await waitFor(() => expect(screen.getByLabelText('Caption')).toHaveValue(''));
  });

  it('sends a PDF as it is and omits an empty caption', async () => {
    mount();
    await userEvent.upload(
      await screen.findByLabelText('Attach a file'),
      new File(['%PDF-1.7'], 'plan.pdf', { type: 'application/pdf', lastModified: 0 }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const form = calls.find((c) => c.method === 'POST')?.body as FormData;
    expect(form.has('caption')).toBe(false);
    expect(form.has('takenAt')).toBe(false);
    expect((form.get('file') as File).name).toBe('plan.pdf');
  });

  it('explains a refused file in plain words', async () => {
    handler = ({ url, method }) =>
      method === 'POST'
        ? { status: 400, body: { error: { code: 'file_type_not_allowed', message: 'raw' } } }
        : defaults({ url, method, body: undefined });
    mount();
    await userEvent
      .setup({ applyAccept: false })
      .upload(
        await screen.findByLabelText('Attach a file'),
        new File(['MZ'], 'photo.jpg', { type: 'application/octet-stream' }),
      );
    expect(
      await screen.findByText('Only JPEG, PNG, PDF, CSV and XLSX files are accepted.'),
    ).toBeInTheDocument();
  });

  it('falls back to the generic message when the network fails', async () => {
    handler = ({ url, method }) => {
      if (method === 'DELETE') throw new Error('network down');
      return defaults({ url, method, body: undefined });
    };
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Remove wall.jpg/ }));
    expect(await screen.findByText(/Could not save/)).toBeInTheDocument();
  });

  it('removes a file with its version and opens a signed link', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Remove wall.jpg/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/files/f1?version=4')).toBe(
        true,
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: /Open plan.pdf/ }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://files.test/f2', '_blank', 'noopener'),
    );
  });

  it('hides upload and remove without the permissions', async () => {
    permissions = [filesPermissions.read];
    mount();
    expect(await screen.findByText('wall.jpg')).toBeInTheDocument();
    expect(screen.queryByLabelText('Attach a file')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
  });
});
