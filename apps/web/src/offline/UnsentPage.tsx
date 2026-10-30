import type { QueueItem } from '@emporium/shared';
import { Alert, Button, Checkbox, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useOffline } from './OfflineProvider';

/** BR-4 and BR-7: every unsent item with its status, the server's reason, and what can be done. */
export function UnsentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { unsent, unsentPhotos, sync, editAndResend, discard, sharedDevice, setSharedDevice } =
    useOffline();

  const photosOf = (item: QueueItem) => unsentPhotos.filter((p) => p.draftKey === item.id).length;

  return (
    <div>
      <Typography.Title level={3}>{t('offline.unsent.title')}</Typography.Title>
      {unsent.length === 0 && <Alert type="success" message={t('offline.unsent.empty')} />}
      {unsent.length > 0 && (
        <Table<QueueItem>
          rowKey="id"
          pagination={false}
          dataSource={unsent}
          columns={[
            {
              title: t('offline.unsent.form'),
              render: (_: unknown, item) =>
                item.source === null ? item.url : t(`offline.unsent.forms.${item.source.formType}`),
            },
            {
              title: t('offline.unsent.status'),
              render: (_: unknown, item) => (
                <Tag color={item.status === 'failed' ? 'red' : 'blue'}>
                  {t(`offline.unsent.state.${item.status}`)}
                </Tag>
              ),
            },
            {
              title: t('offline.unsent.reason'),
              render: (_: unknown, item) => (
                <>
                  {item.lastError === 'offline'
                    ? t('offline.unsent.offlineReason')
                    : item.lastError}{' '}
                  {item.attempts > 0 && (
                    <Typography.Text type="secondary">
                      {t('offline.unsent.attempts', { count: item.attempts })}
                    </Typography.Text>
                  )}
                </>
              ),
            },
            { title: t('offline.unsent.photos'), render: (_: unknown, item) => photosOf(item) },
            {
              title: t('offline.unsent.actions'),
              render: (_: unknown, item) => (
                <Space wrap>
                  {item.status === 'pending' && (
                    <Button size="small" onClick={() => void sync()}>
                      {t('offline.unsent.retry')}
                    </Button>
                  )}
                  {item.status === 'failed' && item.source !== null && (
                    <Button
                      size="small"
                      type="primary"
                      onClick={() =>
                        void editAndResend(item).then((path) => {
                          void navigate(path);
                        })
                      }
                    >
                      {t('offline.unsent.edit')}
                    </Button>
                  )}
                  <Popconfirm
                    title={t('offline.unsent.confirmDiscard')}
                    onConfirm={() => void discard(item)}
                  >
                    <Button size="small" danger>
                      {t('offline.unsent.discard')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      )}
      <Checkbox
        style={{ marginTop: 16 }}
        checked={sharedDevice}
        onChange={(event) => setSharedDevice(event.target.checked)}
      >
        {t('offline.unsent.sharedDevice')}
      </Checkbox>
    </div>
  );
}
