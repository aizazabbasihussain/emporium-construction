import type { StorageClient } from './supabase.store.js';

/** In-memory stand-in for Supabase Storage so the driver is tested without a network (T-3). */
export function createMemoryStorageClient(now: () => Date = () => new Date()): StorageClient & {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
} {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    upload(key, bytes, contentType) {
      if (objects.has(key)) return Promise.resolve('exists');
      objects.set(key, { bytes: new Uint8Array(bytes), contentType });
      return Promise.resolve('created');
    },
    sign(key, expiresInSeconds) {
      const expires = Math.floor(now().getTime() / 1000) + expiresInSeconds;
      return Promise.resolve(
        `https://storage.example.test/object/sign/files/${key}?token=${expires}`,
      );
    },
    remove(key) {
      objects.delete(key);
      return Promise.resolve();
    },
    head: (key) => Promise.resolve(objects.has(key)),
  };
}
