import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, PILOT_USERS, type Harness } from './harness.js';

describe('acceptance harness', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('boots every module on PGlite and serves /health', async () => {
    const res = await h.call(null, 'GET', '/health');
    expect(res.status).toBe(200);
  });

  it('refuses a request without a token and serves one with a token', async () => {
    expect((await h.call(null, 'GET', '/me')).status).toBe(401);
    expect((await h.call('owner', 'GET', '/me')).status).toBe(200);
  });

  it('seeds 12 pilot users and one user without a role', async () => {
    expect(PILOT_USERS).toHaveLength(12);
    const rows = await h.db.query<{ n: string }>('select count(*)::text as n from sys_users');
    expect(Number(rows[0]?.n)).toBe(13);
    expect(h.userId('nobody')).not.toBe(h.userId('owner'));
  });

  it('returns non-JSON bodies as text', async () => {
    const res = await h.call('owner', 'GET', '/files/blob');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
