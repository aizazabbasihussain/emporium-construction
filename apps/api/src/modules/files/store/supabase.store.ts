import { ConflictError } from '@emporium/domain';
import { assertStorageKey, type FileStore } from './file-store.js';

/** The slice of Supabase Storage the driver needs; the real client talks HTTP, tests use a fake. */
export interface StorageClient {
  upload(key: string, bytes: Uint8Array, contentType: string): Promise<'created' | 'exists'>;
  sign(key: string, expiresInSeconds: number): Promise<string>;
  remove(key: string): Promise<void>;
  head(key: string): Promise<boolean>;
}

/** Supabase driver (spec P1-04 BR-6); the service key stays on the server. */
export function createSupabaseFileStore(client: StorageClient): FileStore {
  return {
    async put(key, bytes, contentType) {
      const outcome = await client.upload(assertStorageKey(key), bytes, contentType);
      if (outcome === 'exists') throw new ConflictError('storage_key_exists', 'The key is in use');
    },
    getSignedUrl: async (key, options) =>
      client.sign(assertStorageKey(key), options.expiresInSeconds),
    delete: async (key) => client.remove(assertStorageKey(key)),
    exists: async (key) => client.head(assertStorageKey(key)),
  };
}

export interface SupabaseHttpOptions {
  url: string;
  serviceKey: string;
  bucket: string;
  fetch?: typeof fetch;
}

/** The HTTP client for the Supabase Storage REST API. */
export function createSupabaseStorageClient(options: SupabaseHttpOptions): StorageClient {
  const call = options.fetch ?? fetch;
  const base = `${options.url.replace(/\/$/, '')}/storage/v1`;
  const auth = { authorization: `Bearer ${options.serviceKey}`, apikey: options.serviceKey };
  const objectUrl = (key: string) => `${base}/object/${options.bucket}/${key}`;
  const fail = async (what: string, response: Response): Promise<never> => {
    throw new Error(`Supabase storage ${what} failed with status ${response.status}`);
  };

  return {
    async upload(key, bytes, contentType) {
      const response = await call(objectUrl(key), {
        method: 'POST',
        headers: { ...auth, 'content-type': contentType, 'x-upsert': 'false' },
        body: Buffer.from(bytes),
      });
      if (response.ok) return 'created';
      if (response.status === 409 || response.status === 400) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string };
        if (response.status === 409 || detail.error === 'Duplicate') return 'exists';
      }
      return fail('upload', response);
    },

    async sign(key, expiresInSeconds) {
      const response = await call(`${base}/object/sign/${options.bucket}/${key}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!response.ok) return fail('sign', response);
      const body = (await response.json()) as { signedURL: string };
      return `${base}${body.signedURL}`;
    },

    async remove(key) {
      const response = await call(objectUrl(key), { method: 'DELETE', headers: auth });
      if (!response.ok && response.status !== 404) await fail('delete', response);
    },

    async head(key) {
      const response = await call(objectUrl(key), { method: 'HEAD', headers: auth });
      if (response.ok) return true;
      if (response.status === 404 || response.status === 400) return false;
      return fail('head', response);
    },
  };
}
