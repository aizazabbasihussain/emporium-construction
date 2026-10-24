import { NotFoundError } from '@emporium/domain';
import { NOTIFICATION_RETENTION_DAYS, retentionCutoff } from '@emporium/domain/files';
import type { Clock } from '@emporium/domain/kernel';
import type { Platform } from '../../platform/index.js';
import {
  claimDueReminders,
  countUnread,
  deleteOlderThan,
  insertNotification,
  insertReminder,
  listForUser,
  markAllRead,
  markRead,
  type NotificationRow,
} from '../repo/notifications.repo.js';
import type { Db, NotificationDto, NotificationList, UserDirectory } from '../types.js';
import type { TemplateRegistry } from './templates.service.js';

const LIST_LIMIT = 100;

export interface NotificationsService {
  /** Creates one in-app notification per distinct user (BR-7). Runs in the caller's transaction. */
  notify(
    userIds: readonly string[],
    template: string,
    data: Record<string, unknown>,
    tx: Db,
  ): Promise<number>;
  /** Notifies every active holder of the role. */
  notifyRole(
    roleCode: string,
    template: string,
    data: Record<string, unknown>,
    tx: Db,
  ): Promise<number>;
  /** BR-8: creates a notification for the user once `at` has passed. Returns the reminder id. */
  scheduleReminder(
    userId: string,
    at: Date,
    template: string,
    data: Record<string, unknown>,
    tx: Db,
  ): Promise<string>;
  /** BR-8: delivers each due, unsent reminder exactly once. Returns how many were delivered. */
  tickReminders(db: Db): Promise<number>;
  list(db: Db, userId: string, options?: { unreadOnly?: boolean }): Promise<NotificationList>;
  markRead(id: string, userId: string, requestId: string | null, tx: Db): Promise<NotificationDto>;
  markAllRead(userId: string, requestId: string | null, tx: Db): Promise<number>;
  /** BR-7: removes notifications older than 90 days. Returns how many. */
  purgeOld(db: Db): Promise<number>;
}

export const toNotificationDto = (row: NotificationRow): NotificationDto => ({
  id: row.id,
  template: row.template,
  data: row.data,
  readAt: row.read_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});

export function createNotificationsService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  templates: TemplateRegistry;
  directory: UserDirectory;
}): NotificationsService {
  const { platform, clock, newId, templates, directory } = deps;

  async function deliver(
    tx: Db,
    userIds: readonly string[],
    template: string,
    data: Record<string, unknown>,
    action: string,
  ): Promise<number> {
    templates.require(template);
    const recipients = [...new Set(userIds)];
    if (recipients.length === 0) return 0;
    const at = clock.now();
    for (const userId of recipients) {
      await insertNotification(tx, { id: newId(), userId, template, data, at });
    }
    await platform.audit.record(
      {
        actorUserId: null,
        action,
        entityType: 'notification',
        after: { template, recipients: recipients.length },
      },
      tx,
    );
    await platform.events.publish(
      { type: 'notification.created', payload: { template, userIds: recipients } },
      tx,
    );
    return recipients.length;
  }

  return {
    notify: (userIds, template, data, tx) =>
      deliver(tx, userIds, template, data, 'notification.send'),

    async notifyRole(roleCode, template, data, tx) {
      const holders = await directory.usersWithRole(tx, roleCode);
      return deliver(
        tx,
        holders.map((user) => user.id),
        template,
        data,
        'notification.send',
      );
    },

    async scheduleReminder(userId, at, template, data, tx) {
      templates.require(template);
      const id = newId();
      await insertReminder(tx, { id, userId, dueAt: at, template, data, at: clock.now() });
      await platform.audit.record(
        {
          actorUserId: null,
          action: 'reminder.schedule',
          entityType: 'reminder',
          entityId: id,
          after: { userId, dueAt: at.toISOString(), template },
        },
        tx,
      );
      return id;
    },

    tickReminders(db) {
      return db.transaction(async (tx) => {
        const due = await claimDueReminders(tx, clock.now());
        for (const reminder of due) {
          await deliver(
            tx,
            [reminder.user_id],
            reminder.template,
            reminder.data,
            'reminder.deliver',
          );
        }
        return due.length;
      });
    },

    async list(db, userId, options = {}) {
      const [rows, unread] = await Promise.all([
        listForUser(db, userId, { unreadOnly: options.unreadOnly ?? false, limit: LIST_LIMIT }),
        countUnread(db, userId),
      ]);
      return { items: rows.map(toNotificationDto), unread };
    },

    async markRead(id, userId, requestId, tx) {
      const result = await markRead(tx, id, userId, clock.now());
      if (result === undefined) throw new NotFoundError('notification_not_found', 'Not found');
      if (result.changed) {
        await platform.audit.record(
          {
            actorUserId: userId,
            action: 'notification.read',
            entityType: 'notification',
            entityId: id,
            requestId,
          },
          tx,
        );
      }
      return toNotificationDto(result.row);
    },

    async markAllRead(userId, requestId, tx) {
      const changed = await markAllRead(tx, userId, clock.now());
      if (changed > 0) {
        await platform.audit.record(
          {
            actorUserId: userId,
            action: 'notification.read_all',
            entityType: 'notification',
            after: { count: changed },
            requestId,
          },
          tx,
        );
      }
      return changed;
    },

    async purgeOld(db) {
      const removed = await deleteOlderThan(
        db,
        retentionCutoff(clock.now(), NOTIFICATION_RETENTION_DAYS),
      );
      if (removed > 0) {
        await platform.audit.record(
          {
            actorUserId: null,
            action: 'notification.purge',
            entityType: 'notification',
            after: { count: removed },
          },
          db,
        );
      }
      return removed;
    },
  };
}
