import { expect } from 'vitest';
import type { Harness, PilotUserKey, Response } from './harness.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Reads `a.b.0.c` from a response body; throws a readable error when the path is missing. */
export function val<T = string>(body: unknown, path: string): T {
  let current: unknown = body;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) {
      throw new Error(`Missing ${path} in ${JSON.stringify(body).slice(0, 600)}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current as T;
}

/** A thin client for the scenario: every call must succeed, otherwise the body is shown. */
export function client(h: Harness) {
  const send = async <T = Record<string, unknown>>(
    user: PilotUserKey,
    method: Method,
    url: string,
    body?: unknown,
    expected: number[] = [200, 201, 204],
  ): Promise<Response<T>> => {
    const res = await h.call<T>(user, method, url, body);
    if (!expected.includes(res.status)) {
      throw new Error(
        `${user} ${method} ${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 800)}`,
      );
    }
    return res;
  };

  /** Delivers due outbox events (the scheduler's job in production). */
  const deliver = async () => {
    // A tick delivers at most 50 events; keep going until none is due.
    for (;;) {
      const summary = await h.runtime.platform.events.dispatchDue(h.db);
      if (summary.dispatched + summary.retrying + summary.failed === 0) return;
    }
  };

  /** Approves every pending approval of a user's inbox; returns how many were decided. */
  const approveInbox = async (user: PilotUserKey): Promise<number> => {
    const inbox = await send<{ items: { id: string }[] }>(user, 'GET', '/approvals/inbox');
    for (const item of inbox.body.items) {
      await send(user, 'POST', `/approvals/requests/${item.id}/approve`, {});
    }
    await deliver();
    return inbox.body.items.length;
  };

  /** Attaches a file through `POST /files` (multipart), as the browser does. */
  const upload = async (
    user: PilotUserKey,
    entityType: string,
    entityId: string,
    fileName = 'photo.png',
  ): Promise<Response> => {
    const boundary = '----gate-a-boundary';
    const field = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const payload = Buffer.concat([
      Buffer.from(field('entityType', entityType) + field('entityId', entityId)),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
          'Content-Type: image/png\r\n\r\n',
      ),
      Buffer.from(PNG_BASE64, 'base64'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await h.app.inject({
      method: 'POST',
      url: '/files',
      headers: {
        authorization: `Bearer ${await h.tokenFor(user)}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    if (response.statusCode !== 200 && response.statusCode !== 201) {
      throw new Error(`upload ${entityType} -> ${response.statusCode} ${response.body}`);
    }
    return {
      status: response.statusCode,
      body: JSON.parse(response.body) as Record<string, unknown>,
    };
  };

  /** The current version of a record, read through its GET endpoint. */
  const versionOf = async (user: PilotUserKey, url: string, path = 'version'): Promise<number> =>
    Number(val((await send(user, 'GET', url)).body, path));

  return { send, deliver, approveInbox, versionOf, upload };
}

export type Client = ReturnType<typeof client>;

/** A real 1x1 PNG, used wherever the pilot rules ask for a photo. */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Money in the scenario is compared as strings with two decimals. */
export function money(value: unknown): string {
  expect(typeof value === 'string' || typeof value === 'number').toBe(true);
  return Number(value).toFixed(2);
}
