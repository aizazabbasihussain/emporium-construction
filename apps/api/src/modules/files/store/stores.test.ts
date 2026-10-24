import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { assertStorageKey } from './file-store.js';
import { fileStoreContract } from './file-store.contract.js';
import { createLocalFileStore } from './local.store.js';
import { createMemoryStorageClient } from './memory-storage-client.js';
import { createSupabaseFileStore, createSupabaseStorageClient } from './supabase.store.js';

const KEY = '018f7777-0000-4000-8000-000000000001';
const sign = { expiresInSeconds: 300, fileName: 'plan.pdf', contentType: 'application/pdf' };
const bytes = new TextEncoder().encode('%PDF-1.7 test');
const dirs: string[] = [];
const clock = { current: new Date('2026-10-25T10:00:00Z') };

async function tempDir() {
  const directory = await mkdtemp(path.join(tmpdir(), 'emporium-files-'));
  dirs.push(directory);
  return directory;
}

async function localStore(baseUrl = '') {
  return createLocalFileStore({
    directory: await tempDir(),
    secret: 'test-secret-test-secret',
    baseUrl,
    now: () => clock.current,
  });
}

const tokenOf = (url: string) => new URL(url, 'http://x').searchParams.get('token') as string;

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// T-3 / AC-2: one suite, both drivers.
fileStoreContract('local disk', () => localStore());
fileStoreContract('supabase (in-memory client)', () =>
  createSupabaseFileStore(createMemoryStorageClient(() => clock.current)),
);

describe('assertStorageKey', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(assertStorageKey(KEY)).toBe(KEY);
    expect(() => assertStorageKey('../x')).toThrow(/UUID/);
  });
});

describe('local driver signed URLs (T-4)', () => {
  it('serves the object while the link is valid and not afterwards', async () => {
    const store = await localStore('https://api.example.test');
    await store.put(KEY, bytes, 'application/pdf');
    const url = await store.getSignedUrl(KEY, sign);
    expect(url.startsWith('https://api.example.test/files/blob?token=')).toBe(true);

    clock.current = new Date('2026-10-25T10:04:59Z');
    const download = await store.read(tokenOf(url));
    expect(download).toMatchObject({ contentType: 'application/pdf', fileName: 'plan.pdf' });
    expect(Buffer.from(download.bytes).equals(Buffer.from(bytes))).toBe(true);

    clock.current = new Date('2026-10-25T10:05:00Z');
    await expect(store.read(tokenOf(url))).rejects.toMatchObject({ code: 'link_expired' });
    clock.current = new Date('2026-10-25T10:00:00Z');
  });

  it('rejects a tampered or foreign token', async () => {
    const store = await localStore();
    await store.put(KEY, bytes, 'application/pdf');
    const [, signature] = tokenOf(await store.getSignedUrl(KEY, sign)).split('.') as [
      string,
      string,
    ];
    const body = tokenOf(await store.getSignedUrl(KEY, sign)).split('.')[0] as string;
    const forged = Buffer.from(
      JSON.stringify({ k: KEY, e: 9_999_999_999, t: 'application/pdf', n: 'x.pdf' }),
    ).toString('base64url');
    for (const bad of [`${forged}.${signature}`, `${body}.AAAA`, `${body}.`, 'nothing', '']) {
      await expect(store.read(bad)).rejects.toMatchObject({ code: 'invalid_signature' });
    }
  });

  it('reports a link to a deleted object as expired', async () => {
    const store = await localStore();
    await store.put(KEY, bytes, 'application/pdf');
    const token = tokenOf(await store.getSignedUrl(KEY, sign));
    await store.delete(KEY);
    await expect(store.read(token)).rejects.toMatchObject({ code: 'link_expired' });
  });

  it('surfaces file system errors other than "missing"', async () => {
    const directory = await tempDir();
    const store = createLocalFileStore({
      directory,
      secret: 'test-secret-test-secret',
      baseUrl: '',
      now: () => clock.current,
    });
    await mkdir(path.join(directory, KEY));
    const token = tokenOf(await store.getSignedUrl(KEY, sign));
    await expect(store.read(token)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('supabase HTTP client (T-3, no network)', () => {
  const make = (respond: (url: string, init: RequestInit) => Response) => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        respond(
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
          init ?? {},
        ),
      ),
    );
    return {
      fetchMock,
      client: createSupabaseStorageClient({
        url: 'https://project.supabase.test/',
        serviceKey: 'service-key',
        bucket: 'files',
        fetch: fetchMock,
      }),
    };
  };

  it('uploads without upsert and sends the service key', async () => {
    const { client, fetchMock } = make(() => new Response('{}', { status: 200 }));
    expect(await client.upload(KEY, bytes, 'application/pdf')).toBe('created');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://project.supabase.test/storage/v1/object/files/${KEY}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer service-key',
      'x-upsert': 'false',
    });
  });

  it('maps duplicate answers to "exists" and other failures to errors', async () => {
    const dup409 = make(() => new Response('{}', { status: 409 }));
    expect(await dup409.client.upload(KEY, bytes, 'application/pdf')).toBe('exists');
    const dup400 = make(() => Response.json({ error: 'Duplicate' }, { status: 400 }));
    expect(await dup400.client.upload(KEY, bytes, 'application/pdf')).toBe('exists');
    const bad400 = make(() => Response.json({ error: 'Other' }, { status: 400 }));
    await expect(bad400.client.upload(KEY, bytes, 'application/pdf')).rejects.toThrow(/400/);
    const unparsable = make(() => new Response('not json', { status: 400 }));
    await expect(unparsable.client.upload(KEY, bytes, 'application/pdf')).rejects.toThrow(/400/);
    const down = make(() => new Response('', { status: 500 }));
    await expect(down.client.upload(KEY, bytes, 'application/pdf')).rejects.toThrow(/500/);
  });

  it('signs, removes and checks existence', async () => {
    const signed = make(() => Response.json({ signedURL: `/object/sign/files/${KEY}?token=t` }));
    expect(await signed.client.sign(KEY, 300)).toBe(
      `https://project.supabase.test/storage/v1/object/sign/files/${KEY}?token=t`,
    );
    expect(JSON.parse((signed.fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual(
      { expiresIn: 300 },
    );
    await expect(make(() => new Response('', { status: 500 })).client.sign(KEY, 1)).rejects.toThrow(
      /sign/,
    );

    const status = (code: number) => make(() => new Response('', { status: code })).client;
    await expect(status(200).remove(KEY)).resolves.toBeUndefined();
    await expect(status(404).remove(KEY)).resolves.toBeUndefined();
    await expect(status(500).remove(KEY)).rejects.toThrow(/delete/);

    expect(await status(200).head(KEY)).toBe(true);
    expect(await status(404).head(KEY)).toBe(false);
    expect(await status(400).head(KEY)).toBe(false);
    await expect(status(500).head(KEY)).rejects.toThrow(/head/);
  });
});
