// The only public entry point of the notifications module.
import type { Clock } from '@emporium/domain/kernel';
import type { Platform } from '../platform/index.js';
import { subscribeToApprovalEvents } from './service/approval-events.service.js';
import {
  createNotificationsService,
  type NotificationsService,
} from './service/notifications.service.js';
import { createTemplateRegistry, type TemplateRegistry } from './service/templates.service.js';
import type { ApprovalLookup, UserDirectory } from './types.js';

export interface Notifications {
  service: NotificationsService;
  templates: TemplateRegistry;
  /** Module-to-module API (spec P1-04 section 2); call these inside the owning module's transaction. */
  notify: NotificationsService['notify'];
  notifyRole: NotificationsService['notifyRole'];
  scheduleReminder: NotificationsService['scheduleReminder'];
  /** Later modules register their template codes with the i18n key that renders them (BR-9). */
  registerTemplate: TemplateRegistry['register'];
  tickReminders: NotificationsService['tickReminders'];
  purgeOld: NotificationsService['purgeOld'];
}

/** Wires notifications on top of the kernel and subscribes to the approval events (BR-10). */
export function createNotifications(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  directory: UserDirectory;
  getApprovalState: ApprovalLookup;
}): Notifications {
  const templates = createTemplateRegistry();
  const service = createNotificationsService({ ...deps, templates });
  subscribeToApprovalEvents({
    platform: deps.platform,
    notifications: service,
    directory: deps.directory,
    getApprovalState: deps.getApprovalState,
  });
  return {
    service,
    templates,
    notify: (userIds, template, data, tx) => service.notify(userIds, template, data, tx),
    notifyRole: (roleCode, template, data, tx) => service.notifyRole(roleCode, template, data, tx),
    scheduleReminder: (userId, at, template, data, tx) =>
      service.scheduleReminder(userId, at, template, data, tx),
    registerTemplate: (code, i18nKey) => templates.register(code, i18nKey),
    tickReminders: (db) => service.tickReminders(db),
    purgeOld: (db) => service.purgeOld(db),
  };
}

export {
  registerNotificationsRoutes,
  type NotificationsRouteDeps,
} from './routes/notifications.routes.js';
export type {
  ApprovalLookup,
  DirectoryUser,
  NotificationDto,
  NotificationList,
  UserDirectory,
} from './types.js';
