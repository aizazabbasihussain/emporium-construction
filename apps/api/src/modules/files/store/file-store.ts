import { ValidationError } from '@emporium/domain';

/** What a signed URL should deliver; both drivers may ignore what their backend cannot express. */
export interface SignOptions {
  expiresInSeconds: number;
  fileName: string;
  contentType: string;
}

/**
 * Object storage behind one interface (constitution 4, BR-6). Moving from Supabase Storage to
 * local disk in Pakistan changes configuration (`FILE_STORE_DRIVER`), not code.
 */
export interface FileStore {
  /** Stores new bytes under `key`; an existing key is an error (keys are never reused). */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** A short-lived URL the browser can open without credentials. */
  getSignedUrl(key: string, options: SignOptions): Promise<string>;
  /** Removes the object; removing a missing key is not an error. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** BR-3: storage keys are random UUIDs, so no traversal character can ever reach a driver. */
export function assertStorageKey(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new ValidationError('storage_key_invalid', 'The storage key is not a UUID');
  }
  return key;
}
