// @vitest-environment node
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { QueueItem } from '@emporium/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../admin/api';
import type { CompressDeps } from '../files/compress';
import { openOfflineDb, StorageFullError, type OfflineDb, type PhotoRow } from './db';
import { createDraftStore } from './draftStore';
import { createPhotoQueue } from './photoQueue';
import { createSubmitQueue, outcomeOfError } from './submitQueue';

const DAY = 24 * 60 * 60 * 1000;
let db: OfflineDb;
let clock: number;
let ids: number;

beforeEach(async () => {
  db = await openOfflineDb(new IDBFactory());
  clock = 1_000_000;
  ids = 0;
});

const now = () => clock;
const newId = () => `id-${(ids += 1)}`;

describe('draft store (T-2)', () => {
  it('saves and restores a draft with its time and owner', async () => {
    const drafts = createDraftStore(db, now);
    await drafts.save('dpr:new', 'dpr', { workDone: 'Poured slab' }, 'u1');
    const found = await drafts.get<{ workDone: string }>('dpr:new', 'u1');
    expect(found).toMatchObject({
      key: 'dpr:new',
      formType: 'dpr',
      payload: { workDone: 'Poured slab' },
      updatedAt: 1_000_000,
      userId: 'u1',
    });
  });

  it('overwrites the draft of the same key and keeps the newest', async () => {
    const drafts = createDraftStore(db, now);
    await drafts.save('dpr:new', 'dpr', { v: 1 }, 'u1');
    clock += 500;
    await drafts.save('dpr:new', 'dpr', { v: 2 }, 'u1');
    expect(await drafts.list('u1')).toHaveLength(1);
    expect((await drafts.get<{ v: number }>('dpr:new', 'u1'))?.payload.v).toBe(2);
  });

  it('keeps drafts of two users apart, even under the same key', async () => {
    const drafts = createDraftStore(db, now);
    await drafts.save('dpr:new', 'dpr', { owner: 'one' }, 'u1');
    await drafts.save('dpr:new', 'dpr', { owner: 'two' }, 'u2');
    expect((await drafts.get<{ owner: string }>('dpr:new', 'u1'))?.payload.owner).toBe('one');
    expect((await drafts.get<{ owner: string }>('dpr:new', 'u2'))?.payload.owner).toBe('two');
    expect(await drafts.list('u1')).toHaveLength(1);
    await drafts.remove('dpr:new', 'u2');
    expect(await drafts.get('dpr:new', 'u2')).toBeUndefined();
    expect(await drafts.get('dpr:new', 'u1')).toBeDefined();
  });

  it('survives reopening the database (reload)', async () => {
    const factory = new IDBFactory();
    const first = await openOfflineDb(factory);
    await createDraftStore(first, now).save('attendance:t1:2026-10-30', 'attendance', [1], 'u1');
    const second = await openOfflineDb(factory);
    expect(await createDraftStore(second, now).get('attendance:t1:2026-10-30', 'u1')).toBeDefined();
  });

  it('flags drafts older than 30 days', async () => {
    const drafts = createDraftStore(db, now);
    await drafts.save('old', 'expense', {}, 'u1');
    clock += 31 * DAY;
    await drafts.save('fresh', 'expense', {}, 'u1');
    await drafts.save('other-user-old', 'expense', {}, 'u2');
    expect((await drafts.stale('u1')).map((d) => d.key)).toEqual(['old']);
  });

  it('clears only the user’s own drafts', async () => {
    const drafts = createDraftStore(db, now);
    await drafts.save('a', 'dpr', {}, 'u1');
    await drafts.save('b', 'dpr', {}, 'u2');
    await drafts.clear('u1');
    expect(await drafts.list('u1')).toEqual([]);
    expect(await drafts.list('u2')).toHaveLength(1);
  });
});

describe('storage failures (T-7)', () => {
  it('turns a quota error on write into StorageFullError', async () => {
    const quota = new DOMException('full', 'QuotaExceededError');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw quota;
    });
    try {
      await expect(createDraftStore(db, now).save('k', 'dpr', {}, 'u1')).rejects.toBeInstanceOf(
        StorageFullError,
      );
    } finally {
      put.mockRestore();
    }
  });

  it('lets other write errors through unchanged', async () => {
    const boom = new Error('disk');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw boom;
    });
    try {
      await expect(createDraftStore(db, now).save('k', 'dpr', {}, 'u1')).rejects.toBe(boom);
    } finally {
      put.mockRestore();
    }
  });
});

const sendSpy = () => vi.fn<(item: QueueItem) => Promise<{ id?: string } | null | undefined>>();

describe('submit queue', () => {
  it('queues a request with its own idempotency key and sends it', async () => {
    const send = sendSpy().mockResolvedValue({ id: 'r1' });
    const queue = createSubmitQueue({ db, send, now, newId });
    const item = await queue.enqueue({
      method: 'POST',
      url: '/dpr/reports',
      body: { a: 1 },
      userId: 'u1',
    });
    expect(item).toMatchObject({ status: 'pending', idempotencyKey: 'id-2', attempts: 0 });
    expect(await queue.run('u1')).toBe(1);
    const [sentItem] = await queue.list('u1');
    expect(sentItem).toMatchObject({ status: 'sent', resultId: 'r1' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].idempotencyKey).toBe('id-2');
  });

  it('does not queue the same idempotency key twice', async () => {
    const send = sendSpy().mockResolvedValue({ id: 'r1' });
    const queue = createSubmitQueue({ db, send, now, newId });
    const input = { method: 'POST', url: '/x', body: {}, userId: 'u1', idempotencyKey: 'same' };
    const first = await queue.enqueue(input);
    const second = await queue.enqueue(input);
    expect(second.id).toBe(first.id);
    expect(await queue.list('u1')).toHaveLength(1);
    await queue.run('u1');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the form source with the item', async () => {
    const queue = createSubmitQueue({ db, send: sendSpy(), now, newId });
    const source = {
      formType: 'dpr' as const,
      draftKey: 'dpr:new',
      path: '/dpr/reports/new',
      payload: { x: 1 },
    };
    const item = await queue.enqueue({ method: 'POST', url: '/x', body: {}, userId: 'u1', source });
    expect(item.source).toEqual(source);
  });

  it('retries after a network failure with the same key, following the backoff', async () => {
    const send = sendSpy()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ id: 'r1' });
    const queue = createSubmitQueue({ db, send, now, newId });
    await queue.enqueue({ method: 'POST', url: '/x', body: {}, userId: 'u1' });

    expect(await queue.run('u1')).toBe(0);
    let [item] = await queue.list('u1');
    expect(item).toMatchObject({ status: 'pending', attempts: 1, lastError: 'offline' });
    expect(item?.nextAttemptAt).toBe(clock + 5_000);
    expect(await queue.nextAttempt('u1')).toBe(clock + 5_000);

    // Not due yet: nothing is sent.
    expect(await queue.run('u1')).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);

    clock += 5_000;
    expect(await queue.run('u1')).toBe(0);
    [item] = await queue.list('u1');
    expect(item?.nextAttemptAt).toBe(clock + 15_000);

    // The browser reports online: the wait is skipped.
    await queue.retryNow('u1');
    expect(await queue.run('u1')).toBe(1);
    const keys = send.mock.calls.map(([sent]) => sent.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(await queue.nextAttempt('u1')).toBeNull();
  });

  it('stops on 409 and 422 and keeps the reason for the user', async () => {
    const send = sendSpy()
      .mockRejectedValueOnce(new ApiError(409, 'dpr_exists', 'A report exists for this date'))
      .mockRejectedValueOnce(new ApiError(422, 'invalid', 'Work done is too short'));
    const queue = createSubmitQueue({ db, send, now, newId });
    await queue.enqueue({ method: 'POST', url: '/a', body: {}, userId: 'u1' });
    clock += 1;
    await queue.enqueue({ method: 'POST', url: '/b', body: {}, userId: 'u1' });
    await queue.run('u1');
    const items = await queue.list('u1');
    expect(items.map((i) => [i.status, i.lastError])).toEqual([
      ['failed', 'A report exists for this date'],
      ['failed', 'Work done is too short'],
    ]);
    // A failed item is never retried.
    await queue.retryNow('u1');
    expect(await queue.run('u1')).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('pauses on 401 until sign-in, then sends', async () => {
    const send = sendSpy()
      .mockRejectedValueOnce(new ApiError(401, 'unauthorized', 'Sign in again'))
      .mockResolvedValue({ id: 'r1' });
    const queue = createSubmitQueue({ db, send, now, newId });
    await queue.enqueue({ method: 'POST', url: '/a', body: {}, userId: 'u1' });
    clock += 1;
    await queue.enqueue({ method: 'POST', url: '/b', body: {}, userId: 'u1' });

    expect(await queue.run('u1')).toBe(0);
    expect(queue.paused).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const items = await queue.list('u1');
    expect(items.every((i) => i.status === 'pending' && i.attempts === 0)).toBe(true);

    // Paused: even a due item is not tried.
    expect(await queue.run('u1')).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);

    queue.resume();
    expect(queue.paused).toBe(false);
    expect(await queue.run('u1')).toBe(2);
  });

  it('can be paused from outside', async () => {
    const send = sendSpy().mockResolvedValue({ id: 'r1' });
    const queue = createSubmitQueue({ db, send, now, newId });
    await queue.enqueue({ method: 'POST', url: '/a', body: {}, userId: 'u1' });
    queue.pause();
    expect(await queue.run('u1')).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends another user’s items', async () => {
    const send = sendSpy().mockResolvedValue({ id: 'r1' });
    const queue = createSubmitQueue({ db, send, now, newId });
    await queue.enqueue({ method: 'POST', url: '/a', body: {}, userId: 'u1' });
    await queue.enqueue({ method: 'POST', url: '/b', body: {}, userId: 'u2' });
    expect(await queue.run('u2')).toBe(1);
    expect(send.mock.calls.map(([sent]) => sent.url)).toEqual(['/b']);
    expect(await queue.list('u1')).toHaveLength(1);
    expect(await queue.nextAttempt('u1')).not.toBeNull();
  });

  it('shares one pass between overlapping triggers', async () => {
    let release: (value: { id: string }) => void = () => undefined;
    const send = sendSpy().mockReturnValue(new Promise((resolve) => (release = resolve)));
    const queue = createSubmitQueue({ db, send, now, newId });
    await queue.enqueue({ method: 'POST', url: '/a', body: {}, userId: 'u1' });
    const first = queue.run('u1');
    const second = queue.run('u1');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release({ id: 'r1' });
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips an item the user discarded during the pass and tells the sender hook', async () => {
    const onSent = vi.fn<(item: QueueItem) => void>();
    const send = sendSpy().mockResolvedValue(undefined);
    const queue = createSubmitQueue({ db, send, now, newId, onSent });
    const a = await queue.enqueue({ method: 'POST', url: '/a', body: {}, userId: 'u1' });
    clock += 1;
    const b = await queue.enqueue({ method: 'POST', url: '/b', body: {}, userId: 'u1' });
    send.mockImplementationOnce(async () => {
      await queue.discard(b.id);
      return { id: 'r-a' };
    });
    expect(await queue.run('u1')).toBe(1);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent.mock.calls[0]?.[0].id).toBe(a.id);
    expect((await queue.list('u1')).map((i) => i.id)).toEqual([a.id]);
  });

  it('treats an answer without an id as sent', async () => {
    const queue = createSubmitQueue({ db, send: sendSpy().mockResolvedValue(null), now, newId });
    await queue.enqueue({ method: 'PUT', url: '/a', body: {}, userId: 'u1' });
    await queue.run('u1');
    expect((await queue.list('u1'))[0]).toMatchObject({ status: 'sent', resultId: null });
  });

  it('uses the real clock and ids by default', async () => {
    const queue = createSubmitQueue({ db, send: sendSpy().mockResolvedValue({ id: 'x' }) });
    const item = await queue.enqueue({ method: 'POST', url: '/a', body: {}, userId: 'u1' });
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs(item.createdAt - Date.now())).toBeLessThan(5_000);
  });

  it('maps thrown values to outcomes', () => {
    expect(outcomeOfError(new ApiError(503, 'x', 'busy'))).toEqual({
      kind: 'http',
      status: 503,
      message: 'busy',
    });
    expect(outcomeOfError(new TypeError('Failed to fetch'))).toEqual({ kind: 'network' });
  });
});

const jpeg = (name: string, bytes: number[]) =>
  new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });

/** Compression stand-in that records what it was asked for and returns a smaller file. */
function fakeCompression() {
  const calls: { size: { width: number; height: number }; quality: number }[] = [];
  const deps: CompressDeps = {
    measure: () => Promise.resolve({ width: 4000, height: 3000 }),
    encodeJpeg: (_file, size, quality) => {
      calls.push({ size, quality });
      return Promise.resolve(new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' }));
    },
  };
  return { deps, calls };
}

describe('photo queue (T-3)', () => {
  it('compresses to 1600 px on the long edge at quality 0.7 before storing', async () => {
    const { deps, calls } = fakeCompression();
    const photos = createPhotoQueue({ db, upload: vi.fn(), compression: deps, now, newId });
    expect(await photos.add('dpr:new', jpeg('wall.jpg', [1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);
    expect(calls).toEqual([{ size: { width: 1600, height: 1200 }, quality: 0.7 }]);
    const [row] = await photos.listFor('dpr:new');
    expect(row).toMatchObject({
      name: 'wall.jpg',
      compressed: true,
      status: 'pending',
      attachmentId: null,
    });
    expect(row?.blob.size).toBe(2);
  });

  it('stores a photo that did not shrink as it is, marked not compressed', async () => {
    const deps: CompressDeps = {
      measure: () => Promise.resolve({ width: 100, height: 100 }),
      encodeJpeg: () => Promise.resolve(new Blob([new Uint8Array(50)])),
    };
    const photos = createPhotoQueue({ db, upload: vi.fn(), compression: deps, now, newId });
    await photos.add('dpr:new', jpeg('small.jpg', [1, 2]));
    expect((await photos.list())[0]).toMatchObject({ compressed: false });
  });

  it('queues the same picture of one draft only once', async () => {
    const { deps } = fakeCompression();
    const photos = createPhotoQueue({ db, upload: vi.fn(), compression: deps, now, newId });
    expect(await photos.add('dpr:new', jpeg('a.jpg', [1, 2, 3]))).toBe(true);
    expect(await photos.add('dpr:new', jpeg('b.jpg', [4, 5, 6]))).toBe(false);
    expect(await photos.listFor('dpr:new')).toHaveLength(1);
    // Another draft may hold the same picture.
    expect(await photos.add('dpr:other', jpeg('c.jpg', [7, 8, 9]))).toBe(true);
  });

  it('uploads nothing until the parent record exists, then uploads in order', async () => {
    const upload = vi.fn((_row: PhotoRow, _parent: string) =>
      Promise.resolve({ id: `att-${upload.mock.calls.length}` }),
    );
    let n = 0;
    const deps: CompressDeps = {
      measure: () => Promise.resolve({ width: 10, height: 10 }),
      encodeJpeg: () => Promise.resolve(new Blob([new Uint8Array([(n += 1)])])),
    };
    const photos = createPhotoQueue({ db, upload, compression: deps, now, newId });
    await photos.add('g1', jpeg('first.jpg', [1, 1, 1, 1]));
    clock += 1;
    await photos.add('g1', jpeg('second.jpg', [2, 2, 2, 2]));

    expect(await photos.run(new Map())).toEqual({ uploaded: 0, paused: false });
    expect(upload).not.toHaveBeenCalled();

    expect(await photos.run(new Map([['g1', 'report-1']]))).toEqual({ uploaded: 2, paused: false });
    expect(upload.mock.calls.map(([row, parent]) => [row.name, parent])).toEqual([
      ['first.jpg', 'report-1'],
      ['second.jpg', 'report-1'],
    ]);
    const rows = await photos.listFor('g1');
    expect(rows.map((r) => [r.status, r.attachmentId])).toEqual([
      ['uploaded', 'att-1'],
      ['uploaded', 'att-2'],
    ]);
  });

  it('retries a failed photo on its own while the others go through', async () => {
    const upload = vi
      .fn<(row: PhotoRow, parent: string) => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ id: 'att' });
    let n = 0;
    const deps: CompressDeps = {
      measure: () => Promise.resolve({ width: 10, height: 10 }),
      encodeJpeg: () => Promise.resolve(new Blob([new Uint8Array([(n += 1)])])),
    };
    const photos = createPhotoQueue({ db, upload, compression: deps, now, newId });
    await photos.add('g1', jpeg('first.jpg', [1, 1, 1, 1]));
    clock += 1;
    await photos.add('g1', jpeg('second.jpg', [2, 2, 2, 2]));
    const parents = new Map([['g1', 'report-1']]);

    expect(await photos.run(parents)).toEqual({ uploaded: 1, paused: false });
    let rows = await photos.listFor('g1');
    expect(rows.map((r) => r.status)).toEqual(['pending', 'uploaded']);
    expect(rows[0]).toMatchObject({ attempts: 1, nextAttemptAt: clock + 5_000 });

    // Not due: the failed photo waits for its own time.
    expect(await photos.run(parents)).toEqual({ uploaded: 0, paused: false });
    clock += 5_000;
    expect(await photos.run(parents)).toEqual({ uploaded: 1, paused: false });
    rows = await photos.listFor('g1');
    expect(rows.every((r) => r.status === 'uploaded')).toBe(true);
  });

  it('retryNow makes waiting photos due again', async () => {
    const upload = vi
      .fn<(row: PhotoRow, parent: string) => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ id: 'att' });
    const { deps } = fakeCompression();
    const photos = createPhotoQueue({ db, upload, compression: deps, now, newId });
    await photos.add('g1', jpeg('a.jpg', [1, 2, 3]));
    const parents = new Map([['g1', 'r']]);
    await photos.run(parents);
    await photos.retryNow();
    expect(await photos.run(parents)).toEqual({ uploaded: 1, paused: false });
  });

  it('stops on a server refusal without blocking other photos', async () => {
    const upload = vi
      .fn<(row: PhotoRow, parent: string) => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new ApiError(422, 'file_type_not_allowed', 'Not allowed'))
      .mockResolvedValue({ id: 'att' });
    let n = 0;
    const deps: CompressDeps = {
      measure: () => Promise.resolve({ width: 10, height: 10 }),
      encodeJpeg: () => Promise.resolve(new Blob([new Uint8Array([(n += 1)])])),
    };
    const photos = createPhotoQueue({ db, upload, compression: deps, now, newId });
    await photos.add('g1', jpeg('bad.jpg', [1, 1, 1, 1]));
    clock += 1;
    await photos.add('g1', jpeg('good.jpg', [2, 2, 2, 2]));
    await photos.run(new Map([['g1', 'r']]));
    const rows = await photos.listFor('g1');
    expect(rows.map((r) => [r.name, r.status, r.lastError])).toEqual([
      ['bad.jpg', 'failed', 'Not allowed'],
      ['good.jpg', 'uploaded', null],
    ]);
  });

  it('stops the whole run when sign-in has lapsed', async () => {
    const upload = vi
      .fn<(row: PhotoRow, parent: string) => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new ApiError(401, 'unauthorized', 'Sign in'));
    let n = 0;
    const deps: CompressDeps = {
      measure: () => Promise.resolve({ width: 10, height: 10 }),
      encodeJpeg: () => Promise.resolve(new Blob([new Uint8Array([(n += 1)])])),
    };
    const photos = createPhotoQueue({ db, upload, compression: deps, now, newId });
    await photos.add('g1', jpeg('a.jpg', [1, 1, 1, 1]));
    clock += 1;
    await photos.add('g1', jpeg('b.jpg', [2, 2, 2, 2]));
    expect(await photos.run(new Map([['g1', 'r']]))).toEqual({ uploaded: 0, paused: true });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(
      (await photos.listFor('g1')).every((r) => r.status === 'pending' && r.attempts === 0),
    ).toBe(true);
  });

  it('moves a group to another key and settles delivered photos', async () => {
    const upload = vi.fn().mockResolvedValue({ id: 'att' });
    let n = 0;
    const deps: CompressDeps = {
      measure: () => Promise.resolve({ width: 10, height: 10 }),
      encodeJpeg: () => Promise.resolve(new Blob([new Uint8Array([(n += 1)])])),
    };
    const photos = createPhotoQueue({ db, upload, compression: deps, now, newId });
    await photos.add('form', jpeg('a.jpg', [1, 1, 1, 1]));
    clock += 1;
    await photos.add('form', jpeg('b.jpg', [2, 2, 2, 2]));
    await photos.rekey('form', 'item-1');
    expect(await photos.listFor('form')).toEqual([]);
    expect(await photos.listFor('item-1')).toHaveLength(2);

    expect(await photos.settle('item-1')).toBe(false);
    await photos.run(new Map([['item-1', 'r']]));
    expect(await photos.settle('item-1')).toBe(true);
    expect(await photos.list()).toEqual([]);
    // A group with no photos is settled.
    expect(await photos.settle('nothing')).toBe(true);
  });

  it('removes one photo', async () => {
    const { deps } = fakeCompression();
    const photos = createPhotoQueue({ db, upload: vi.fn(), compression: deps, now, newId });
    await photos.add('g1', jpeg('a.jpg', [1, 2, 3]));
    const [row] = await photos.list();
    await photos.remove(row?.id as string);
    expect(await photos.list()).toEqual([]);
  });

  it('uses the browser clock and ids by default', async () => {
    const { deps } = fakeCompression();
    const photos = createPhotoQueue({ db, upload: vi.fn(), compression: deps });
    await photos.add('g1', jpeg('a.jpg', [1, 2, 3]));
    const [row] = await photos.list();
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
