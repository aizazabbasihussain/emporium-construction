import { formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, List, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { notificationsApi, templateKey, type NotificationItem } from './api';

export function NotificationsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['notifications'], queryFn: () => notificationsApi.list() });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const read = useMutation({ mutationFn: notificationsApi.read, onSuccess: refresh });
  const readAll = useMutation({ mutationFn: notificationsApi.readAll, onSuccess: refresh });

  const text = (item: NotificationItem): string =>
    t(templateKey(item.template), {
      ...item.data,
      amount: typeof item.data.amount === 'string' ? formatAmount(item.data.amount) : '',
    });

  return (
    <div>
      <Typography.Title level={3}>{t('notifications.title')}</Typography.Title>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      {(read.isError || readAll.isError) && <Alert type="error" message={t('common.saveError')} />}
      <Space style={{ marginBottom: 12 }}>
        <Button
          disabled={(list.data?.unread ?? 0) === 0}
          loading={readAll.isPending}
          onClick={() => readAll.mutate()}
        >
          {t('notifications.markAllRead')}
        </Button>
      </Space>
      <List<NotificationItem>
        bordered
        loading={list.isLoading}
        locale={{ emptyText: t('notifications.empty') }}
        dataSource={list.data?.items ?? []}
        renderItem={(item) => (
          <List.Item
            actions={
              item.readAt === null
                ? [
                    <Button
                      key="read"
                      size="small"
                      loading={read.isPending && read.variables === item.id}
                      onClick={() => read.mutate(item.id)}
                    >
                      {t('notifications.markRead')}
                    </Button>,
                  ]
                : []
            }
          >
            <List.Item.Meta
              title={<Typography.Text strong={item.readAt === null}>{text(item)}</Typography.Text>}
              description={formatDate(item.createdAt.slice(0, 10))}
            />
          </List.Item>
        )}
      />
    </div>
  );
}
