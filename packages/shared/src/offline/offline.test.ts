import { describe, expect, it } from 'vitest';
import {
  applyOutcome,
  backoffDelay,
  dueItems,
  enqueueItem,
  isDuplicatePhoto,
  isStaleDraft,
  isStorageLow,
  isUnsent,
  nextDueAt,
  submittedConflict,
  uploadable,
  draftKey,
  lowStorageBytes,
  type PhotoRecord,
  type QueueItem,
} from './index.js';

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 'q1',
  idempotencyKey: 'k1',
  method: 'POST',
  url: '/dpr/reports',
  body: { a: 1 },
  userId: 'u1',
  source: null,
  resultId: null,
  createdAt: 100,
  status: 'pending',
  attempts: 0,
  nextAttemptAt: 0,
  lastError: null,
  ...over,
});

const photo = (over: Partial<PhotoRecord> = {}): PhotoRecord => ({
  id: 'p1',
  draftKey: 'dpr:new',
  name: 'a.jpg',
  compressed: true,
  checksum: 'abc',
  attachmentId: null,
  createdAt: 1,
  status: 'pending',
  attempts: 0,
  nextAttemptAt: 0,
  lastError: null,
  ...over,
});

describe('backoff schedule (BR-3)', () => {
  it('waits 5 s, 15 s, 60 s, 5 min and then 15 min', () => {
    expect([1, 2, 3, 4, 5, 6, 40].map(backoffDelay)).toEqual([
      5_000, 15_000, 60_000, 300_000, 900_000, 900_000, 900_000,
    ]);
  });

  it('treats zero attempts like the first', () => {
    expect(backoffDelay(0)).toBe(5_000);
  });
});

describe('applyOutcome (BR-3, BR-4)', () => {
  it('marks a delivered item sent and keeps the created id', () => {
    const { item: next, pauseQueue } = applyOutcome(
      item({ lastError: 'offline' }),
      { kind: 'ok', resultId: 'r1' },
      1_000,
      'sent',
      'failed',
    );
    expect(next).toMatchObject({ status: 'sent', resultId: 'r1', lastError: null });
    expect(pauseQueue).toBe(false);
  });

  it('marks a delivered item sent when the answer has no id', () => {
    const { item: next } = applyOutcome(item(), { kind: 'ok' }, 1_000, 'sent', 'failed');
    expect(next).toMatchObject({ status: 'sent', resultId: null });
    expect(
      applyOutcome(item(), { kind: 'ok', resultId: null }, 1, 'sent', 'failed').item.status,
    ).toBe('sent');
  });

  it('retries a network failure after the next backoff step', () => {
    const first = applyOutcome(item(), { kind: 'network' }, 1_000, 'sent', 'failed');
    expect(first.item).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 6_000,
      lastError: 'offline',
    });
    const second = applyOutcome(first.item, { kind: 'network' }, 10_000, 'sent', 'failed');
    expect(second.item).toMatchObject({ attempts: 2, nextAttemptAt: 25_000 });
  });

  it('retries a server error with its message', () => {
    const { item: next } = applyOutcome(
      item(),
      { kind: 'http', status: 503, message: 'busy' },
      0,
      'sent',
      'failed',
    );
    expect(next).toMatchObject({ status: 'pending', attempts: 1, lastError: 'busy' });
  });

  it.each([409, 422])('stops on %i and keeps the reason', (status) => {
    const { item: next, pauseQueue } = applyOutcome(
      item(),
      { kind: 'http', status, message: 'Date already reported' },
      0,
      'sent',
      'failed',
    );
    expect(next).toMatchObject({
      status: 'failed',
      lastError: 'Date already reported',
      attempts: 1,
    });
    expect(pauseQueue).toBe(false);
  });

  it('pauses the queue on 401 without using up an attempt', () => {
    const { item: next, pauseQueue } = applyOutcome(
      item({ attempts: 2 }),
      { kind: 'http', status: 401, message: 'signed out' },
      0,
      'sent',
      'failed',
    );
    expect(next).toMatchObject({ status: 'pending', attempts: 2, lastError: 'signed out' });
    expect(pauseQueue).toBe(true);
  });
});

describe('dueItems and nextDueAt', () => {
  const items = [
    item({ id: 'b', idempotencyKey: 'kb', createdAt: 200 }),
    item({ id: 'a', idempotencyKey: 'ka', createdAt: 100 }),
    item({ id: 'later', idempotencyKey: 'kl', nextAttemptAt: 5_000 }),
    item({ id: 'sent', idempotencyKey: 'ks', status: 'sent' }),
    item({ id: 'failed', idempotencyKey: 'kf', status: 'failed' }),
    item({ id: 'other', idempotencyKey: 'ko', userId: 'u2' }),
  ];

  it('lists this user’s pending due items oldest first', () => {
    expect(dueItems(items, 1_000, 'u1', false).map((i) => i.id)).toEqual(['a', 'b']);
    expect(dueItems(items, 5_000, 'u1', false).map((i) => i.id)).toContain('later');
  });

  it('lists nothing while paused', () => {
    expect(dueItems(items, 1_000, 'u1', true)).toEqual([]);
  });

  it('finds the earliest pending time of the user', () => {
    expect(nextDueAt(items, 'u1')).toBe(0);
    expect(nextDueAt([item({ nextAttemptAt: 9 }), item({ nextAttemptAt: 7 })], 'u1')).toBe(7);
    expect(
      nextDueAt(
        items.filter((i) => i.status !== 'pending'),
        'u1',
      ),
    ).toBeNull();
  });
});

describe('enqueueItem', () => {
  it('adds a new item', () => {
    const result = enqueueItem([], item());
    expect(result.added).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it('ignores an item whose idempotency key is queued already', () => {
    const result = enqueueItem([item()], item({ id: 'q2' }));
    expect(result.added).toBe(false);
    expect(result.items.map((i) => i.id)).toEqual(['q1']);
  });
});

describe('unsent', () => {
  it('counts waiting and failed items as unsent, not sent ones', () => {
    expect(isUnsent(item())).toBe(true);
    expect(isUnsent(item({ status: 'failed' }))).toBe(true);
    expect(isUnsent(item({ status: 'sent' }))).toBe(false);
  });
});

describe('drafts (BR-2, BR-6, BR-8)', () => {
  it('builds a key from form type and scope', () => {
    expect(draftKey('attendance', 't1:2026-10-30')).toBe('attendance:t1:2026-10-30');
  });

  it('flags drafts older than 30 days', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(isStaleDraft({ updatedAt: 0 }, 30 * day)).toBe(false);
    expect(isStaleDraft({ updatedAt: 0 }, 30 * day + 1)).toBe(true);
  });

  it('warns below 50 MB of free storage', () => {
    expect(isStorageLow({ quota: 100 * 1024 * 1024, usage: 60 * 1024 * 1024 })).toBe(true);
    expect(isStorageLow({ quota: lowStorageBytes * 3, usage: lowStorageBytes })).toBe(false);
    expect(isStorageLow({ quota: lowStorageBytes + 1, usage: 0 })).toBe(false);
    expect(isStorageLow({ quota: lowStorageBytes, usage: 1 })).toBe(true);
    expect(isStorageLow(null)).toBe(false);
    expect(isStorageLow({ quota: 1 })).toBe(false);
    expect(isStorageLow({ usage: 1 })).toBe(false);
  });

  it('detects a submitted report for the same date only', () => {
    const existing = [
      { reportDate: '2026-10-29', status: 'submitted' },
      { reportDate: '2026-10-30', status: 'draft' },
      { reportDate: '2026-10-31', status: 'reviewed' },
    ];
    expect(submittedConflict('2026-10-29', existing)).toBe(true);
    expect(submittedConflict('2026-10-31', existing)).toBe(true);
    expect(submittedConflict('2026-10-30', existing)).toBe(false);
    expect(submittedConflict('2026-11-01', existing)).toBe(false);
  });
});

describe('photo queue rules (BR-5)', () => {
  const parents = new Map([['dpr:new', 'r1']]);

  it('uploads only after the parent exists, oldest first', () => {
    const photos = [
      photo({ id: 'p2', createdAt: 2 }),
      photo({ id: 'p1', createdAt: 1 }),
      photo({ id: 'orphan', draftKey: 'dpr:other' }),
    ];
    expect(uploadable(photos, parents, 0).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(uploadable(photos, new Map(), 0)).toEqual([]);
  });

  it('skips photos that are done, failed or waiting for their own retry', () => {
    const photos = [
      photo({ id: 'done', status: 'uploaded' }),
      photo({ id: 'failed', status: 'failed' }),
      photo({ id: 'wait', nextAttemptAt: 10 }),
      photo({ id: 'ready' }),
    ];
    expect(uploadable(photos, parents, 5).map((p) => p.id)).toEqual(['ready']);
    expect(uploadable(photos, parents, 10).map((p) => p.id)).toContain('wait');
  });

  it('retries one photo independently of another', () => {
    const failing = applyOutcome(photo({ id: 'a' }), { kind: 'network' }, 0, 'uploaded', 'failed');
    const other = photo({ id: 'b' });
    expect(failing.item.nextAttemptAt).toBe(5_000);
    expect(uploadable([failing.item, other], parents, 0).map((p) => p.id)).toEqual(['b']);
  });

  it('recognizes a duplicate by checksum within one draft', () => {
    const photos = [photo()];
    expect(isDuplicatePhoto(photos, 'dpr:new', 'abc')).toBe(true);
    expect(isDuplicatePhoto(photos, 'dpr:new', 'zzz')).toBe(false);
    expect(isDuplicatePhoto(photos, 'dpr:other', 'abc')).toBe(false);
  });
});
