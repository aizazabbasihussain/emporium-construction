import { Alert, Space, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useOffline } from './OfflineProvider';

/** BR-7: online or offline, and how much is still waiting to be sent; BR-6: storage warnings. */
export function SyncStatusBar() {
  const { t } = useTranslation();
  const { available, online, unsent, unsentPhotos, storageLow, staleDraftCount } = useOffline();
  if (!available) return null;
  return (
    <div role="status" aria-label={t('offline.viewUnsent')} style={{ marginBottom: 12 }}>
      <Space wrap>
        <Tag color={online ? 'green' : 'red'}>
          {t(online ? 'offline.online' : 'offline.offline')}
        </Tag>
        {unsent.length > 0 || unsentPhotos.length > 0 ? (
          <Link to="/offline/unsent">
            {unsent.length > 0 && t('offline.unsentCount', { count: unsent.length })}
            {unsent.length > 0 && unsentPhotos.length > 0 && ', '}
            {unsentPhotos.length > 0 && t('offline.photosCount', { count: unsentPhotos.length })}
          </Link>
        ) : (
          <span>{t('offline.allSent')}</span>
        )}
      </Space>
      {storageLow && <Alert type="warning" showIcon message={t('offline.storageLow')} />}
      {staleDraftCount > 0 && (
        <Alert
          type="info"
          showIcon
          message={t('offline.staleDrafts', { count: staleDraftCount })}
        />
      )}
    </div>
  );
}
