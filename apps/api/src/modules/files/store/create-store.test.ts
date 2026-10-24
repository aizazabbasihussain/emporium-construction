import { describe, expect, it } from 'vitest';
import { createFileStore } from './create-store.js';

const now = () => new Date('2026-10-25T10:00:00Z');

describe('createFileStore (BR-6)', () => {
  it('builds the local driver and exposes it for signed downloads', async () => {
    const created = createFileStore(
      {
        driver: 'local',
        local: { directory: '/tmp/x', secret: 'secret-secret-secret', baseUrl: '' },
      },
      now,
    );
    expect(created.local).toBeDefined();
    expect(created.store).toBe(created.local);
  });

  it('builds the Supabase driver without a local download endpoint', () => {
    const created = createFileStore(
      {
        driver: 'supabase',
        supabase: { url: 'https://p.supabase.test', serviceKey: 'k', bucket: 'files' },
      },
      now,
    );
    expect(created.local).toBeUndefined();
    expect(created.store).toHaveProperty('getSignedUrl');
  });

  it('names the missing variables when a driver has no settings', () => {
    expect(() => createFileStore({ driver: 'local' }, now)).toThrow(/FILE_STORE_LOCAL_DIR/);
    expect(() => createFileStore({ driver: 'supabase' }, now)).toThrow(/SUPABASE_SERVICE_KEY/);
  });
});
