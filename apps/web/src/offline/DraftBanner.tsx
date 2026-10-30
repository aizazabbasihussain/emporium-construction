import { Alert, Button, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import type { UseDraft } from './useDraft';

const when = (at: number) =>
  new Date(at).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'short',
    timeStyle: 'short',
  });

/** BR-2: offers to restore a draft found on the device; BR-6: says when it is old or storage is full. */
export function DraftBanner<P>({
  draft,
  onRestore,
}: {
  draft: UseDraft<P>;
  onRestore: (payload: P) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {draft.storageFull && (
        <Alert
          type="error"
          showIcon
          message={t('offline.storageFull')}
          style={{ marginBottom: 12 }}
        />
      )}
      {draft.found !== null && (
        <Alert
          type={draft.foundIsStale ? 'warning' : 'info'}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <>
              {t('offline.banner.title', { when: when(draft.found.updatedAt) })}
              {draft.foundIsStale && <> {t('offline.banner.stale')}</>}
            </>
          }
          action={
            <Space>
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  const payload = draft.restore();
                  if (payload !== null) onRestore(payload);
                }}
              >
                {t('offline.banner.restore')}
              </Button>
              <Button size="small" onClick={() => void draft.clear()}>
                {t('offline.banner.discard')}
              </Button>
            </Space>
          }
        />
      )}
    </>
  );
}
