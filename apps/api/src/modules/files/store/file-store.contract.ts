import { describe, expect, it } from 'vitest';
import type { FileStore } from './file-store.js';

const KEY_A = '018f7777-0000-4000-8000-000000000001';
const KEY_B = '018f7777-0000-4000-8000-000000000002';
const sign = { expiresInSeconds: 300, fileName: 'plan.pdf', contentType: 'application/pdf' };
const bytes = new TextEncoder().encode('%PDF-1.7 test');

/** The behaviour every driver must show (BR-6, AC-2); each driver's test file calls this. */
export function fileStoreContract(name: string, make: () => Promise<FileStore> | FileStore): void {
  describe(`FileStore contract: ${name}`, () => {
    it('stores an object and reports that it exists', async () => {
      const store = await make();
      expect(await store.exists(KEY_A)).toBe(false);
      await store.put(KEY_A, bytes, 'application/pdf');
      expect(await store.exists(KEY_A)).toBe(true);
      expect(await store.exists(KEY_B)).toBe(false);
    });

    it('refuses to overwrite an existing key', async () => {
      const store = await make();
      await store.put(KEY_A, bytes, 'application/pdf');
      await expect(store.put(KEY_A, bytes, 'application/pdf')).rejects.toMatchObject({
        code: 'storage_key_exists',
      });
    });

    it('deletes an object and tolerates deleting it again', async () => {
      const store = await make();
      await store.put(KEY_A, bytes, 'application/pdf');
      await store.delete(KEY_A);
      expect(await store.exists(KEY_A)).toBe(false);
      await expect(store.delete(KEY_A)).resolves.toBeUndefined();
    });

    it('issues a distinct signed URL per key', async () => {
      const store = await make();
      await store.put(KEY_A, bytes, 'application/pdf');
      await store.put(KEY_B, bytes, 'application/pdf');
      const [a, b] = [await store.getSignedUrl(KEY_A, sign), await store.getSignedUrl(KEY_B, sign)];
      expect(a).toMatch(/^(https?:\/\/|\/files\/blob\?)/);
      expect(a).not.toBe(b);
    });

    it('rejects keys that are not UUIDs (path traversal)', async () => {
      const store = await make();
      for (const key of ['../secret', 'a/b', '', KEY_A + '/x']) {
        await expect(store.put(key, bytes, 'application/pdf')).rejects.toMatchObject({
          code: 'storage_key_invalid',
        });
        await expect(store.exists(key)).rejects.toMatchObject({ code: 'storage_key_invalid' });
        await expect(store.delete(key)).rejects.toMatchObject({ code: 'storage_key_invalid' });
        await expect(store.getSignedUrl(key, sign)).rejects.toMatchObject({
          code: 'storage_key_invalid',
        });
      }
    });
  });
}
