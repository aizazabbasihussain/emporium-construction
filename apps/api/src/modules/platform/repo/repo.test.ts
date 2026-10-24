import { createTestDb, type SqlDb } from '@emporium/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { insertAudit, searchAudit } from './audit.repo.js';
import { findIdempotent, storeIdempotent } from './idempotency.repo.js';
import {
  consume,
  findDue,
  findEvent,
  insertEvent,
  listFailed,
  markDispatched,
  recordAttempt,
  requeueFailed,
} from './outbox.repo.js';
import {
  insertSeries,
  listSeries,
  lockSeries,
  storeCounter,
  updateSeriesDefinition,
} from './series.repo.js';
import { findSetting, insertSetting, updateSetting } from './settings.repo.js';

let db: SqlDb;
const id = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const user = id(900);
const t0 = new Date('2026-10-24T10:00:00Z');

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe('audit repo', () => {
  it('inserts and searches by every filter, newest first, with paging', async () => {
    const base = { actorUserId: user, entityType: 'doc', before: null, after: { a: 1 } };
    await insertAudit(db, { ...base, id: id(1), action: 'a', entityId: 'd1', requestId: 'r1' });
    await insertAudit(db, {
      ...base,
      id: id(2),
      action: 'b',
      entityId: 'd2',
      requestId: null,
      actorUserId: null,
      entityType: 'other',
    });
    const page = { limit: 10, offset: 0 };
    expect((await searchAudit(db, page)).map((r) => r.id)).toHaveLength(2);
    expect(await searchAudit(db, { ...page, entityType: 'doc' })).toHaveLength(1);
    expect(await searchAudit(db, { ...page, entityId: 'd2' })).toHaveLength(1);
    expect(await searchAudit(db, { ...page, actorUserId: user })).toHaveLength(1);
    expect(await searchAudit(db, { ...page, from: '2100-01-01T00:00:00Z' })).toHaveLength(0);
    expect(await searchAudit(db, { ...page, to: '2000-01-01T00:00:00Z' })).toHaveLength(0);
    expect(await searchAudit(db, { limit: 1, offset: 1 })).toHaveLength(1);
    const [row] = await searchAudit(db, { ...page, entityId: 'd1' });
    expect(row).toMatchObject({ action: 'a', request_id: 'r1', after: { a: 1 }, before: null });
  });
});

describe('series repo', () => {
  const def = {
    code: 'repo_test',
    prefix: 'RT',
    padding: 3,
    resetYearly: false,
    gapless: false,
    startValue: 1,
    nextValue: 1,
  };

  it('inserts, locks, stores the counter, lists and updates with a version check', async () => {
    const inserted = await insertSeries(db, def, user);
    expect(inserted).toMatchObject({ code: 'repo_test', version: 1, created_by: user });
    expect(await lockSeries(db, 'missing')).toBeUndefined();
    await db.transaction(async (tx) => {
      expect(await lockSeries(tx, 'repo_test')).toMatchObject({ prefix: 'RT' });
      await storeCounter(tx, 'repo_test', { nextValue: 9, currentYear: 2026 });
    });
    expect(await lockSeries(db, 'repo_test')).toMatchObject({
      next_value: expect.anything() as unknown,
      current_year: 2026,
    });
    expect((await listSeries(db)).map((s) => s.code)).toContain('repo_test');
    const updated = await updateSeriesDefinition(db, {
      code: 'repo_test',
      expectedVersion: 1,
      patch: { prefix: 'RX' },
      actor: user,
    });
    expect(updated).toMatchObject({ prefix: 'RX', version: 2, updated_by: user });
  });
});

describe('outbox repo', () => {
  it('inserts, finds due events, tracks attempts, failures, requeue and consumption', async () => {
    await insertEvent(db, { id: id(10), type: 't', payload: { x: 1 }, occurredAt: t0 });
    await insertEvent(db, { id: id(11), type: 't', payload: null, occurredAt: t0 });
    expect(await findDue(db, new Date(t0.getTime() - 1), 10)).toHaveLength(0);
    expect((await findDue(db, t0, 10)).map((e) => e.id)).toEqual([id(10), id(11)]);
    expect(await findDue(db, t0, 1)).toHaveLength(1);
    expect(await findEvent(db, id(10))).toMatchObject({ payload: { x: 1 } });
    expect(await findEvent(db, id(99))).toBeUndefined();

    expect(await consume(db, id(10), 'h')).toBe(true);
    expect(await consume(db, id(10), 'h')).toBe(false);
    expect(await consume(db, id(10), 'other')).toBe(true);

    await markDispatched(db, id(10), t0);
    expect((await findDue(db, t0, 10)).map((e) => e.id)).toEqual([id(11)]);

    const later = new Date(t0.getTime() + 1000);
    await recordAttempt(db, id(11), {
      attempts: 1,
      nextAttemptAt: later,
      error: 'e',
      failedAt: null,
    });
    expect(await findDue(db, t0, 10)).toHaveLength(0);
    expect(await findDue(db, later, 10)).toHaveLength(1);
    expect(await listFailed(db)).toHaveLength(0);

    await recordAttempt(db, id(11), {
      attempts: 5,
      nextAttemptAt: later,
      error: 'e',
      failedAt: later,
    });
    expect((await listFailed(db)).map((e) => e.id)).toEqual([id(11)]);
    expect(await requeueFailed(db, id(10), later)).toBeUndefined();
    expect(await requeueFailed(db, id(11), later)).toMatchObject({ attempts: 0, last_error: null });
    expect(await listFailed(db)).toHaveLength(0);
  });
});

describe('idempotency repo', () => {
  it('stores and finds by key and user', async () => {
    expect(await findIdempotent(db, 'k', user)).toBeUndefined();
    await storeIdempotent(db, {
      key: 'k',
      user_id: user,
      request_hash: 'h',
      response: { ok: true },
      status_code: 201,
    });
    expect(await findIdempotent(db, 'k', user)).toMatchObject({
      request_hash: 'h',
      response: { ok: true },
      status_code: 201,
    });
    expect(await findIdempotent(db, 'k', id(901))).toBeUndefined();
    await storeIdempotent(db, {
      key: 'k2',
      user_id: user,
      request_hash: 'h',
      response: undefined,
      status_code: 204,
    });
    expect((await findIdempotent(db, 'k2', user))?.response).toBeNull();
  });
});

describe('settings repo', () => {
  it('finds, inserts and updates under a version check', async () => {
    expect(await findSetting(db, 'backdating_days')).toMatchObject({ value: 3, version: 1 });
    expect(await findSetting(db, 'new_key')).toBeUndefined();
    const inserted = await insertSetting(db, {
      key: 'new_key',
      value: 'abc',
      description: 'd',
      actor: user,
    });
    expect(inserted).toMatchObject({ value: 'abc', version: 1 });
    const updated = await updateSetting(db, {
      key: 'new_key',
      value: 'def',
      expectedVersion: 1,
      actor: null,
    });
    expect(updated).toMatchObject({ value: 'def', version: 2 });
    await expect(
      updateSetting(db, { key: 'new_key', value: 'x', expectedVersion: 1, actor: null }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });
});
