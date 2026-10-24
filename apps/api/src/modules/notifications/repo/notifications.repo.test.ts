import { createTestDb, type SqlDb } from '@emporium/db';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  claimDueReminders,
  countUnread,
  deleteOlderThan,
  insertNotification,
  insertReminder,
  listForUser,
  markAllRead,
  markRead,
} from './notifications.repo.js';

let db: SqlDb;
const id = (n: number) => `018f6666-3333-7000-8000-${String(n).padStart(12, '0')}`;
const alice = id(900);
const bob = id(901);
const at = (hours: number) => new Date(Date.UTC(2026, 9, 25, hours));

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe('ntf_notifications', () => {
  it('lists a user newest first, only their own, optionally only unread', async () => {
    await insertNotification(db, {
      id: id(1),
      userId: alice,
      template: 't',
      data: { n: 1 },
      at: at(1),
    });
    await insertNotification(db, {
      id: id(2),
      userId: alice,
      template: 't',
      data: { n: 2 },
      at: at(2),
    });
    await insertNotification(db, { id: id(3), userId: bob, template: 't', data: {}, at: at(3) });

    const all = await listForUser(db, alice, { unreadOnly: false, limit: 10 });
    expect(all.map((r) => r.id)).toEqual([id(2), id(1)]);
    expect(all[0]?.data).toEqual({ n: 2 });
    expect(await countUnread(db, alice)).toBe(2);
    expect(
      (await listForUser(db, alice, { unreadOnly: false, limit: 1 })).map((r) => r.id),
    ).toEqual([id(2)]);
  });

  it('marks one notification read once and keeps the first read time (BR-7)', async () => {
    const first = await markRead(db, id(1), alice, at(5));
    expect(first?.changed).toBe(true);
    expect(first?.row.read_at?.toISOString()).toBe(at(5).toISOString());
    const again = await markRead(db, id(1), alice, at(9));
    expect(again?.changed).toBe(false);
    expect(again?.row.read_at?.toISOString()).toBe(at(5).toISOString());

    expect(await markRead(db, id(3), alice, at(5))).toBeUndefined();
    expect(await markRead(db, id(404), alice, at(5))).toBeUndefined();
    expect(
      (await listForUser(db, alice, { unreadOnly: true, limit: 10 })).map((r) => r.id),
    ).toEqual([id(2)]);
    expect(await countUnread(db, alice)).toBe(1);
  });

  it('marks every unread notification of the user and nobody else', async () => {
    expect(await markAllRead(db, alice, at(6))).toBe(1);
    expect(await markAllRead(db, alice, at(7))).toBe(0);
    expect(await countUnread(db, bob)).toBe(1);
  });

  it('deletes notifications created before the cutoff', async () => {
    expect(await deleteOlderThan(db, at(2))).toBe(1);
    expect(await deleteOlderThan(db, at(2))).toBe(0);
    expect(
      (await listForUser(db, alice, { unreadOnly: false, limit: 10 })).map((r) => r.id),
    ).toEqual([id(2)]);
  });

  it('rejects an empty template', async () => {
    await expect(
      insertNotification(db, { id: id(4), userId: alice, template: '', data: {}, at: at(1) }),
    ).rejects.toThrow();
  });
});

describe('ntf_reminders', () => {
  it('claims each due reminder once and leaves future ones', async () => {
    await insertReminder(db, {
      id: id(11),
      userId: alice,
      dueAt: at(8),
      template: 't',
      data: { a: 1 },
      at: at(1),
    });
    await insertReminder(db, {
      id: id(12),
      userId: bob,
      dueAt: at(9),
      template: 't',
      data: {},
      at: at(1),
    });
    await insertReminder(db, {
      id: id(13),
      userId: alice,
      dueAt: at(20),
      template: 't',
      data: {},
      at: at(1),
    });

    expect(await claimDueReminders(db, at(7))).toEqual([]);
    const due = await claimDueReminders(db, at(10));
    expect(due.map((r) => r.id)).toEqual([id(11), id(12)]);
    expect(due[0]).toMatchObject({ user_id: alice, data: { a: 1 } });
    expect(due[0]?.sent_at?.toISOString()).toBe(at(10).toISOString());
    expect(await claimDueReminders(db, at(10))).toEqual([]);
    expect((await claimDueReminders(db, at(21))).map((r) => r.id)).toEqual([id(13)]);
  });
});
