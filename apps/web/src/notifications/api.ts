import { approvalNotificationTemplates, crmNotificationTemplates } from '@emporium/shared';
import { request } from '../admin/api';

export interface NotificationItem {
  id: string;
  template: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: NotificationItem[];
  unread: number;
}

export const notificationsApi = {
  list: () => request<NotificationList>('GET', '/notifications'),
  read: (id: string) => request<NotificationItem>('POST', `/notifications/${id}/read`),
  readAll: () => request<{ updated: number }>('POST', '/notifications/read-all'),
};

/** The i18n key of a template code (BR-9); modules that register their own template add it here. */
export function templateKey(code: string): string {
  const known: Record<string, string> = {
    ...approvalNotificationTemplates,
    ...crmNotificationTemplates,
  };
  return known[code] ?? 'notifications.unknown';
}
