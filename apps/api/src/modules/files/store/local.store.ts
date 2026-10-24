import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConflictError, ForbiddenError } from '@emporium/domain';
import { assertStorageKey, type FileStore, type SignOptions } from './file-store.js';

interface TokenPayload {
  k: string;
  e: number;
  t: string;
  n: string;
}

export interface LocalFileStoreOptions {
  /** Directory that holds the objects. */
  directory: string;
  /** Key for signing download tokens; kept on the server. */
  secret: string;
  /** Prefix of the download URL, for example `https://api.example.test` (empty for same origin). */
  baseUrl: string;
  now: () => Date;
}

export interface LocalDownload {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
}

export interface LocalFileStore extends FileStore {
  /** Verifies a download token from a signed URL and returns the object (BR-4). */
  read(token: string): Promise<LocalDownload>;
}

/** Local-disk driver: the Pakistan-hosted production target (spec P1-04 BR-6). */
export function createLocalFileStore(options: LocalFileStoreOptions): LocalFileStore {
  const sign = (body: string) =>
    createHmac('sha256', options.secret).update(body).digest('base64url');
  const fileOf = (key: string) => path.join(options.directory, assertStorageKey(key));
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

  const exists = async (key: string): Promise<boolean> => {
    try {
      return (await stat(fileOf(key))).isFile();
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  };

  return {
    async put(key, bytes) {
      if (await exists(key)) throw new ConflictError('storage_key_exists', 'The key is in use');
      await mkdir(options.directory, { recursive: true });
      await writeFile(fileOf(key), bytes, { flag: 'wx' });
    },

    async getSignedUrl(key, sign_: SignOptions) {
      assertStorageKey(key);
      const payload: TokenPayload = {
        k: key,
        e: Math.floor(options.now().getTime() / 1000) + sign_.expiresInSeconds,
        t: sign_.contentType,
        n: sign_.fileName,
      };
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${options.baseUrl}/files/blob?token=${body}.${sign(body)}`;
    },

    async delete(key) {
      await rm(fileOf(key), { force: true });
    },

    exists,

    async read(token) {
      const [body = '', signature = ''] = token.split('.');
      const expected = Buffer.from(sign(body));
      const given = Buffer.from(signature);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new ForbiddenError('invalid_signature', 'The link is not valid');
      }
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
      if (payload.e * 1000 <= options.now().getTime()) {
        throw new ForbiddenError('link_expired', 'The link has expired');
      }
      try {
        return {
          bytes: await readFile(fileOf(payload.k)),
          contentType: payload.t,
          fileName: payload.n,
        };
      } catch (error) {
        if (missing(error)) throw new ForbiddenError('link_expired', 'The link has expired');
        throw error;
      }
    },
  };
}
