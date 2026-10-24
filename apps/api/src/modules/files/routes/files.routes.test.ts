import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN,
  EXE,
  JPEG,
  NOBODY,
  PDF,
  PM,
  PNG,
  createFilesKit,
  multipartBody,
  type FilesKit,
} from '../test-support.js';

let kit: FilesKit;

beforeAll(async () => {
  kit = await createFilesKit('local');
}, 60_000);
afterAll(() => kit.close());

const auth = async (userId: string) => ({ authorization: `Bearer ${await kit.token(userId)}` });

const post = async (
  userId: string,
  fields: Record<string, string>,
  file?: { name: string; bytes: Uint8Array },
) => {
  const form = multipartBody(fields, file);
  return kit.app.inject({
    method: 'POST',
    url: '/files',
    payload: form.payload,
    headers: { ...form.headers, ...(await auth(userId)) },
  });
};

const entityFor = (...users: string[]) => {
  const entity = kit.entity();
  kit.allow(entity, ...users);
  return entity;
};

describe('POST /files', () => {
  it('stores a file and answers 201 with the attachment (AC-1)', async () => {
    const entity = entityFor(ADMIN);
    const response = await post(
      ADMIN,
      { entityType: 'test_doc', entityId: entity, caption: 'north wall', latitude: '33.7' },
      { name: 'wall.jpg', bytes: JPEG },
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      entityId: entity,
      fileName: 'wall.jpg',
      contentType: 'image/jpeg',
      caption: 'north wall',
      latitude: 33.7,
    });
  });

  it('answers a retry of the same bytes with 200 and the same attachment (BR-2)', async () => {
    const entity = entityFor(ADMIN);
    const fields = { entityType: 'test_doc', entityId: entity };
    const first = await post(ADMIN, fields, { name: 'a.png', bytes: PNG });
    const retry = await post(ADMIN, fields, { name: 'a.png', bytes: PNG });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
  });

  it('rejects a renamed executable, a missing file and bad fields with 400', async () => {
    const entity = entityFor(ADMIN);
    const fields = { entityType: 'test_doc', entityId: entity };
    const exe = await post(ADMIN, fields, { name: 'photo.jpg', bytes: EXE });
    expect(exe.statusCode).toBe(400);
    expect(exe.json<{ error: { code: string } }>().error.code).toBe('file_type_not_allowed');

    const none = await post(ADMIN, fields);
    expect(none.json<{ error: { code: string } }>().error.code).toBe('file_required');

    const badId = await post(
      ADMIN,
      { entityType: 'test_doc', entityId: 'nope' },
      {
        name: 'a.png',
        bytes: PNG,
      },
    );
    expect(badId.json<{ error: { code: string } }>().error.code).toBe('validation_failed');

    const traversal = await post(ADMIN, fields, { name: '..%2F..%2Fx.png', bytes: PNG });
    expect(traversal.json<{ error: { code: string } }>().error.code).toBe('file_name_invalid');
    // The multipart parser keeps only the last path segment of the client's file name.
    const slash = await post(ADMIN, fields, { name: 'a/b.pdf', bytes: PDF });
    expect(slash.json<{ fileName: string }>().fileName).toBe('b.pdf');
  });

  it('rejects a file over 10 MB', async () => {
    const entity = entityFor(ADMIN);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG);
    const response = await post(
      ADMIN,
      { entityType: 'test_doc', entityId: entity },
      {
        name: 'big.jpg',
        bytes: big,
      },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('file_too_large');
  });

  it('denies a caller without the permission (403) or without access to the entity (404)', async () => {
    const entity = entityFor(ADMIN);
    const fields = { entityType: 'test_doc', entityId: entity };
    expect((await post(NOBODY, fields, { name: 'a.png', bytes: PNG })).statusCode).toBe(403);
    expect((await post(PM, fields, { name: 'a.png', bytes: PNG })).statusCode).toBe(404);
    const unauthenticated = await kit.app.inject({ method: 'POST', url: '/files' });
    expect(unauthenticated.statusCode).toBe(401);
  });
});

describe('GET /files and GET /files/:id/url', () => {
  it('lists and fetches for a permitted user, not for another (AC-1, T-4)', async () => {
    const entity = entityFor(ADMIN, PM);
    const created = await post(
      ADMIN,
      { entityType: 'test_doc', entityId: entity },
      { name: 'plan.pdf', bytes: PDF },
    );
    const { id } = created.json<{ id: string }>();

    const list = await kit.app.inject({
      method: 'GET',
      url: `/files?entityType=test_doc&entityId=${entity}`,
      headers: await auth(PM),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([id]);

    const link = await kit.app.inject({
      method: 'GET',
      url: `/files/${id}/url`,
      headers: await auth(PM),
    });
    expect(link.statusCode).toBe(200);
    const { url, expiresAt } = link.json<{ url: string; expiresAt: string }>();
    expect(expiresAt).toBe('2026-10-25T10:05:00.000Z');

    // The browser opens the link without credentials; the signature is the credential.
    const path = url.replace('https://api.example.test', '');
    const download = await kit.app.inject({ method: 'GET', url: path });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['content-disposition']).toContain('inline; filename*=UTF-8');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(download.rawPayload).equals(Buffer.from(PDF))).toBe(true);

    kit.now.current = new Date('2026-10-25T10:05:00Z');
    const expired = await kit.app.inject({ method: 'GET', url: path });
    expect(expired.statusCode).toBe(403);
    expect(expired.json<{ error: { code: string } }>().error.code).toBe('link_expired');
    kit.now.current = new Date('2026-10-25T10:00:00Z');

    const denied = await kit.app.inject({
      method: 'GET',
      url: `/files/${id}/url`,
      headers: await auth(NOBODY),
    });
    expect(denied.statusCode).toBe(403);
    kit.allow(entity, ADMIN);
    const hidden = await kit.app.inject({
      method: 'GET',
      url: `/files/${id}/url`,
      headers: await auth(PM),
    });
    expect(hidden.statusCode).toBe(404);
    const hiddenList = await kit.app.inject({
      method: 'GET',
      url: `/files?entityType=test_doc&entityId=${entity}`,
      headers: await auth(PM),
    });
    expect(hiddenList.statusCode).toBe(404);
  });

  it('serves a non-previewable file as an attachment and rejects a forged link', async () => {
    const entity = entityFor(ADMIN);
    const csv = Uint8Array.from([...'a,b\n1,2\n'].map((ch) => ch.charCodeAt(0)));
    const created = await post(
      ADMIN,
      { entityType: 'test_doc', entityId: entity },
      { name: 'rates.csv', bytes: csv },
    );
    const { id } = created.json<{ id: string }>();
    const link = await kit.app.inject({
      method: 'GET',
      url: `/files/${id}/url`,
      headers: await auth(ADMIN),
    });
    const path = link.json<{ url: string }>().url.replace('https://api.example.test', '');
    const download = await kit.app.inject({ method: 'GET', url: path });
    expect(download.headers['content-disposition']).toContain('attachment; filename*=UTF-8');

    const forged = await kit.app.inject({ method: 'GET', url: `${path}x` });
    expect(forged.statusCode).toBe(403);
    expect(forged.json<{ error: { code: string } }>().error.code).toBe('invalid_signature');
  });

  it('validates query and path parameters and answers 404 for an unknown file', async () => {
    const headers = await auth(ADMIN);
    expect((await kit.app.inject({ method: 'GET', url: '/files', headers })).statusCode).toBe(400);
    expect(
      (await kit.app.inject({ method: 'GET', url: '/files/not-a-uuid/url', headers })).statusCode,
    ).toBe(400);
    const missing = await kit.app.inject({
      method: 'GET',
      url: '/files/018f0000-0000-7000-8000-000000000000/url',
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(
      (await kit.app.inject({ method: 'GET', url: '/files?entityType=a&entityId=b' })).statusCode,
    ).toBe(401);
  });
});

describe('DELETE /files/:id', () => {
  const create = async (entity: string) =>
    (
      await post(ADMIN, { entityType: 'test_doc', entityId: entity }, { name: 'a.png', bytes: PNG })
    ).json<{ id: string; version: number }>();

  it('removes softly and replays the same answer for a retry with the same key', async () => {
    const entity = entityFor(ADMIN);
    const { id } = await create(entity);
    const headers = { ...(await auth(ADMIN)), 'idempotency-key': 'remove-1' };
    const first = await kit.app.inject({ method: 'DELETE', url: `/files/${id}`, headers });
    const retry = await kit.app.inject({ method: 'DELETE', url: `/files/${id}`, headers });
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());

    const again = await kit.app.inject({
      method: 'DELETE',
      url: `/files/${id}`,
      headers: await auth(ADMIN),
    });
    expect(again.statusCode).toBe(404);
    const list = await kit.app.inject({
      method: 'GET',
      url: `/files?entityType=test_doc&entityId=${entity}`,
      headers: await auth(ADMIN),
    });
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('answers 409 for a stale version, 403 without permission, 404 outside the entity', async () => {
    const entity = entityFor(ADMIN);
    const { id } = await create(entity);
    const stale = await kit.app.inject({
      method: 'DELETE',
      url: `/files/${id}?version=7`,
      headers: await auth(ADMIN),
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (await kit.app.inject({ method: 'DELETE', url: `/files/${id}`, headers: await auth(NOBODY) }))
        .statusCode,
    ).toBe(403);
    expect(
      (await kit.app.inject({ method: 'DELETE', url: `/files/${id}`, headers: await auth(PM) }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await kit.app.inject({
          method: 'DELETE',
          url: `/files/${id}?version=0`,
          headers: await auth(ADMIN),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('rejects a malformed Idempotency-Key', async () => {
    const entity = entityFor(ADMIN);
    const { id } = await create(entity);
    const response = await kit.app.inject({
      method: 'DELETE',
      url: `/files/${id}`,
      headers: { ...(await auth(ADMIN)), 'idempotency-key': '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_idempotency_key');
  });
});
