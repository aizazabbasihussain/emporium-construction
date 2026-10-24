import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN,
  ESTIMATOR,
  OWNER,
  createNotificationsKit,
  type NotificationsKit,
} from '../test-support.js';

let kit: NotificationsKit;

beforeAll(async () => {
  kit = await createNotificationsKit();
  await kit.db.transaction(async (tx) => {
    await kit.notifications.notify([ESTIMATOR], 'approval.approved', { n: 1 }, tx);
    await kit.notifications.notify([ESTIMATOR], 'approval.rejected', { n: 2 }, tx);
    await kit.notifications.notify([OWNER], 'approval.approved', { n: 3 }, tx);
  });
}, 60_000);
afterAll(() => kit.close());

const as = async (userId: string, headers: Record<string, string> = {}) => ({
  authorization: `Bearer ${await kit.token(userId)}`,
  ...headers,
});

interface ListBody {
  items: { id: string; template: string; readAt: string | null }[];
  unread: number;
}

describe('GET /notifications', () => {
  it('returns only the own notifications with the unread count (T-6)', async () => {
    const response = await kit.app.inject({
      method: 'GET',
      url: '/notifications',
      headers: await as(ESTIMATOR),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ListBody>();
    expect(body.unread).toBe(2);
    expect(body.items.map((i) => i.template).sort()).toEqual([
      'approval.approved',
      'approval.rejected',
    ]);
  });

  it('can limit the list to unread notifications', async () => {
    const [first] = (
      await kit.app.inject({ method: 'GET', url: '/notifications', headers: await as(ESTIMATOR) })
    ).json<ListBody>().items;
    await kit.app.inject({
      method: 'POST',
      url: `/notifications/${first?.id}/read`,
      headers: await as(ESTIMATOR),
    });
    const unread = await kit.app.inject({
      method: 'GET',
      url: '/notifications?unread=true',
      headers: await as(ESTIMATOR),
    });
    expect(unread.json<ListBody>().items).toHaveLength(1);
  });

  it('rejects a bad query with 400 and an anonymous caller with 401', async () => {
    const bad = await kit.app.inject({
      method: 'GET',
      url: '/notifications?unread=maybe',
      headers: await as(ESTIMATOR),
    });
    expect(bad.statusCode).toBe(400);
    expect((await kit.app.inject({ method: 'GET', url: '/notifications' })).statusCode).toBe(401);
  });
});

describe('POST /notifications/:id/read', () => {
  it('is idempotent: the first read time is kept and an Idempotency-Key retry replays', async () => {
    const owner = (
      await kit.app.inject({ method: 'GET', url: '/notifications', headers: await as(OWNER) })
    ).json<ListBody>().items[0];
    const headers = await as(OWNER, { 'idempotency-key': 'read-1' });
    const first = await kit.app.inject({
      method: 'POST',
      url: `/notifications/${owner?.id}/read`,
      headers,
    });
    kit.now.current = new Date('2026-10-25T10:30:00Z');
    const retry = await kit.app.inject({
      method: 'POST',
      url: `/notifications/${owner?.id}/read`,
      headers,
    });
    const again = await kit.app.inject({
      method: 'POST',
      url: `/notifications/${owner?.id}/read`,
      headers: await as(OWNER),
    });
    kit.now.current = new Date('2026-10-25T10:00:00Z');
    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(again.json<{ readAt: string }>().readAt).toBe(first.json<{ readAt: string }>().readAt);
  });

  it("answers 404 for another user's or an unknown notification and 400 for a bad id", async () => {
    const owner = (
      await kit.app.inject({ method: 'GET', url: '/notifications', headers: await as(OWNER) })
    ).json<ListBody>().items[0];
    const foreign = await kit.app.inject({
      method: 'POST',
      url: `/notifications/${owner?.id}/read`,
      headers: await as(ADMIN),
    });
    expect(foreign.statusCode).toBe(404);
    const unknown = await kit.app.inject({
      method: 'POST',
      url: '/notifications/018f0000-0000-7000-8000-000000000000/read',
      headers: await as(ADMIN),
    });
    expect(unknown.statusCode).toBe(404);
    const bad = await kit.app.inject({
      method: 'POST',
      url: '/notifications/not-a-uuid/read',
      headers: await as(ADMIN),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects a malformed Idempotency-Key', async () => {
    const response = await kit.app.inject({
      method: 'POST',
      url: '/notifications/018f0000-0000-7000-8000-000000000000/read',
      headers: await as(ADMIN, { 'idempotency-key': '' }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_idempotency_key');
  });
});

describe('POST /notifications/read-all', () => {
  it('marks everything read, and a retry changes nothing', async () => {
    const first = await kit.app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: await as(ESTIMATOR),
    });
    expect(first.json()).toEqual({ updated: 1 });
    const second = await kit.app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: await as(ESTIMATOR),
    });
    expect(second.json()).toEqual({ updated: 0 });
    const list = await kit.app.inject({
      method: 'GET',
      url: '/notifications',
      headers: await as(ESTIMATOR),
    });
    expect(list.json<ListBody>().unread).toBe(0);
  });

  it('requires authentication', async () => {
    expect(
      (await kit.app.inject({ method: 'POST', url: '/notifications/read-all' })).statusCode,
    ).toBe(401);
  });
});
