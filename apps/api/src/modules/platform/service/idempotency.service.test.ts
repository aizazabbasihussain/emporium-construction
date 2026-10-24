import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ID, OTHER_ID, createKernel, type Kernel } from '../test-support.js';
import { hashRequest } from './idempotency.service.js';

let k: Kernel;
let runs = 0;

beforeAll(async () => {
  k = await createKernel();
}, 60_000);

const exec = (userId: string, key: string, requestHash: string) =>
  k.platform.idempotency.execute(k.db, { key, userId, requestHash }, async () => {
    runs += 1;
    return { statusCode: 201, body: { run: runs } };
  });

describe('idempotency (T-5)', () => {
  it('replays the stored response for the same key and hash without re-executing', async () => {
    const first = await exec(ADMIN_ID, 'k1', 'h1');
    const again = await exec(ADMIN_ID, 'k1', 'h1');
    expect(first).toEqual({ statusCode: 201, body: { run: 1 }, replayed: false });
    expect(again).toEqual({ statusCode: 201, body: { run: 1 }, replayed: true });
    expect(runs).toBe(1);
  });

  it('returns 422 for the same key with a different hash', async () => {
    await expect(exec(ADMIN_ID, 'k1', 'other')).rejects.toMatchObject({
      kind: 'rule_violation',
      code: 'idempotency_key_reused',
    });
  });

  it('keeps different users independent', async () => {
    const other = await exec(OTHER_ID, 'k1', 'h-other');
    expect(other.replayed).toBe(false);
    expect(runs).toBe(2);
  });

  it('does not store a response when the command fails', async () => {
    await expect(
      k.platform.idempotency.execute(
        k.db,
        { key: 'k2', userId: ADMIN_ID, requestHash: 'h' },
        async () => {
          throw new Error('nope');
        },
      ),
    ).rejects.toThrow('nope');
    expect((await exec(ADMIN_ID, 'k2', 'h')).replayed).toBe(false);
  });

  it('hashes the request deterministically', () => {
    expect(hashRequest('post', '/x', { a: 1 })).toBe(hashRequest('POST', '/x', { a: 1 }));
    expect(hashRequest('POST', '/x', { a: 1 })).not.toBe(hashRequest('POST', '/x', { a: 2 }));
    expect(hashRequest('POST', '/x', undefined)).toBe(hashRequest('POST', '/x', null));
  });
});
