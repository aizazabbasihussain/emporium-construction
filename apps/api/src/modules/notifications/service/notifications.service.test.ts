import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN,
  DISABLED_PM,
  ESTIMATOR,
  OWNER,
  PM,
  PM2,
  createNotificationsKit,
  type NotificationsKit,
} from '../test-support.js';

let kit: NotificationsKit;

beforeAll(async () => {
  kit = await createNotificationsKit();
}, 60_000);
afterAll(() => kit.close());

const tx = <T>(fn: (db: typeof kit.db) => Promise<T>) => kit.db.transaction(fn);
const T = 'approval.approved';

describe('notify and notifyRole (T-6)', () => {
  it('creates one notification per distinct user with audit and outbox entries', async () => {
    const created = await tx((db) =>
      kit.notifications.notify([ADMIN, ADMIN, ESTIMATOR], T, { docType: 'expense' }, db),
    );
    expect(created).toBe(2);
    expect(await kit.inboxOf(ADMIN)).toEqual([{ template: T, data: { docType: 'expense' } }]);
    expect(await kit.inboxOf(ESTIMATOR)).toHaveLength(1);
    expect(
      await kit.db.query(`select 1 from sys_audit_log where action = 'notification.send'`),
    ).toHaveLength(1);
    const events = await kit.db.query<{ type: string }>(
      `select type from sys_outbox where type = 'notification.created'`,
    );
    expect(events).toHaveLength(1);
  });

  it('does nothing for an empty audience', async () => {
    const before = await kit.db.query('select id from sys_outbox');
    expect(await tx((db) => kit.notifications.notify([], T, {}, db))).toBe(0);
    expect(await kit.db.query('select id from sys_outbox')).toHaveLength(before.length);
  });

  it('fails fast on an unregistered template and writes nothing', async () => {
    await expect(
      tx((db) => kit.notifications.notify([ADMIN], 'no.such', {}, db)),
    ).rejects.toMatchObject({
      code: 'unknown_template',
    });
  });

  it('notifies every active holder of a role and skips disabled users', async () => {
    const created = await tx((db) =>
      kit.notifications.notifyRole('project_manager', 'approval.requested', { n: 1 }, db),
    );
    expect(created).toBe(2);
    expect(await kit.inboxOf(PM)).toHaveLength(1);
    expect(await kit.inboxOf(PM2)).toHaveLength(1);
    expect(await kit.inboxOf(DISABLED_PM)).toHaveLength(0);
    expect(await tx((db) => kit.notifications.notifyRole('storekeeper', T, {}, db))).toBe(0);
  });

  it('accepts templates that later modules register', async () => {
    kit.notifications.registerTemplate(
      'lead.assigned',
      'notifications.templates.approvalRequested',
    );
    expect(await tx((db) => kit.notifications.notify([OWNER], 'lead.assigned', {}, db))).toBe(1);
  });
});

describe('reminders (BR-8, T-6)', () => {
  it('delivers a due reminder exactly once, even under two concurrent ticks', async () => {
    const due = new Date('2026-10-25T10:30:00Z');
    const id = await tx((db) =>
      kit.notifications.scheduleReminder(OWNER, due, 'approval.cancelled', { why: 'visit' }, db),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    expect(await kit.notifications.tickReminders(kit.db)).toBe(0);
    const before = (await kit.inboxOf(OWNER)).length;

    kit.now.current = new Date('2026-10-25T10:30:00Z');
    const results = await Promise.all([
      kit.notifications.tickReminders(kit.db),
      kit.notifications.tickReminders(kit.db),
    ]);
    expect(results.sort()).toEqual([0, 1]);
    const after = await kit.inboxOf(OWNER);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toEqual({ template: 'approval.cancelled', data: { why: 'visit' } });
    expect(await kit.notifications.tickReminders(kit.db)).toBe(0);
    expect(
      await kit.db.query(`select 1 from sys_audit_log where action = 'reminder.schedule'`),
    ).toHaveLength(1);
    expect(
      await kit.db.query(`select 1 from sys_audit_log where action = 'reminder.deliver'`),
    ).toHaveLength(1);
    kit.now.current = new Date('2026-10-25T10:00:00Z');
  });

  it('refuses a reminder with an unknown template', async () => {
    await expect(
      tx((db) => kit.notifications.scheduleReminder(OWNER, new Date(), 'no.such', {}, db)),
    ).rejects.toMatchObject({ code: 'unknown_template' });
  });
});

describe('reading and purging (BR-7, T-6)', () => {
  it('lists the newest first with the unread count', async () => {
    const list = await kit.notifications.service.list(kit.db, ESTIMATOR);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.unread).toBe(list.items.length);
    expect(list.items[0]?.readAt).toBeNull();
    expect(typeof list.items[0]?.template).toBe('string');
  });

  it('marks a notification read idempotently and writes the audit entry once', async () => {
    const [first] = (await kit.notifications.service.list(kit.db, ESTIMATOR)).items;
    const id = first?.id as string;
    kit.now.current = new Date('2026-10-25T11:00:00Z');
    const one = await tx((db) => kit.notifications.service.markRead(id, ESTIMATOR, 'req-1', db));
    kit.now.current = new Date('2026-10-25T12:00:00Z');
    const two = await tx((db) => kit.notifications.service.markRead(id, ESTIMATOR, 'req-2', db));
    expect(two.readAt).toBe(one.readAt);
    expect(one.readAt).toBe('2026-10-25T11:00:00.000Z');
    expect(
      await kit.db.query(`select 1 from sys_audit_log where action = 'notification.read'`),
    ).toHaveLength(1);

    const only = await kit.notifications.service.list(kit.db, ESTIMATOR, { unreadOnly: true });
    expect(only.items.map((i) => i.id)).not.toContain(id);
  });

  it("hides another user's notification as not found", async () => {
    const [first] = (await kit.notifications.service.list(kit.db, ESTIMATOR)).items;
    await expect(
      tx((db) => kit.notifications.service.markRead(first?.id as string, ADMIN, null, db)),
    ).rejects.toMatchObject({ code: 'notification_not_found' });
  });

  it('marks everything read, and a second call changes nothing', async () => {
    expect(await tx((db) => kit.notifications.service.markAllRead(ADMIN, null, db))).toBe(1);
    expect(await tx((db) => kit.notifications.service.markAllRead(ADMIN, null, db))).toBe(0);
    expect((await kit.notifications.service.list(kit.db, ADMIN)).unread).toBe(0);
    expect(
      await kit.db.query(`select 1 from sys_audit_log where action = 'notification.read_all'`),
    ).toHaveLength(1);
  });

  it('purges notifications after 90 days and keeps younger ones', async () => {
    kit.now.current = new Date('2026-10-25T09:00:00Z');
    await tx((db) => kit.notifications.notify([ESTIMATOR], T, { marker: 'old' }, db));
    kit.now.current = new Date('2027-01-22T09:00:00Z'); // 89 days later
    expect(await kit.notifications.purgeOld(kit.db)).toBe(0);
    kit.now.current = new Date('2027-01-24T09:00:00Z'); // 91 days later
    const removed = await kit.notifications.purgeOld(kit.db);
    expect(removed).toBeGreaterThan(0);
    expect(await kit.notifications.purgeOld(kit.db)).toBe(0);
    expect(await kit.inboxOf(ESTIMATOR)).toEqual([]);
    expect(
      await kit.db.query(`select 1 from sys_audit_log where action = 'notification.purge'`),
    ).toHaveLength(1);
  });
});
