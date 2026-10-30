import { Alert, Button, List, Space } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StorageFullError, type PhotoRow } from './db';
import { useOffline } from './OfflineProvider';

/**
 * BR-5: photos picked before the report exists. They are compressed and stored on the device and
 * upload one by one after the report is created.
 */
export function QueuedPhotos({ draftKey }: { draftKey: string }) {
  const { t } = useTranslation();
  const { photos } = useOffline();
  const [rows, setRows] = useState<PhotoRow[]>([]);
  const [full, setFull] = useState(false);

  const reload = useCallback(async () => {
    if (photos !== null) setRows(await photos.listFor(draftKey));
  }, [photos, draftKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (photos === null) return null;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {full && <Alert type="error" showIcon message={t('offline.storageFull')} />}
      <input
        type="file"
        multiple
        accept="image/jpeg,image/png"
        aria-label={t('files.upload')}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = '';
          void (async () => {
            try {
              for (const file of picked) await photos.add(draftKey, file);
              setFull(false);
            } catch (cause) {
              if (cause instanceof StorageFullError) setFull(true);
            }
            await reload();
          })();
        }}
      />
      <List
        size="small"
        dataSource={rows}
        renderItem={(row) => (
          <List.Item
            actions={[
              <Button
                key="remove"
                size="small"
                onClick={() => void photos.remove(row.id).then(reload)}
              >
                {t('files.remove')}
              </Button>,
            ]}
          >
            {row.name}
          </List.Item>
        )}
      />
    </Space>
  );
}
