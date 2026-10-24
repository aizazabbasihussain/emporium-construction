import { notificationsPermissions } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { notificationsApi } from './api';

const POLL_MS = 60_000;

/** The bell in the header: a link to the list with the unread count (spec P1-04 section 5). */
export function NotificationBell() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can(notificationsPermissions.readOwn);
  const list = useQuery({
    queryKey: ['notifications'],
    queryFn: () => notificationsApi.list(),
    enabled: allowed,
    refetchInterval: POLL_MS,
  });
  if (!allowed) return null;
  const unread = list.data?.unread ?? 0;
  return (
    <Badge count={unread} size="small" overflowCount={99}>
      <Link to="/notifications" aria-label={t('notifications.bell', { count: unread })}>
        <Button size="small">{t('notifications.title')}</Button>
      </Link>
    </Badge>
  );
}
