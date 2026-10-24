import { filesPermissions } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Input, Space, Typography } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { filesApi, type Attachment } from './api';
import { browserDeps, compressImage, type CompressDeps } from './compress';

export interface AttachmentUploaderProps {
  /** The owning module's entity type and id; this component knows nothing else about the entity. */
  entityType: string;
  entityId: string;
  /** Replaced in tests; the browser canvas implementation is used otherwise. */
  compression?: CompressDeps;
}

function Thumbnail({ attachment }: { attachment: Attachment }) {
  const link = useQuery({
    queryKey: ['file-url', attachment.id],
    queryFn: () => filesApi.url(attachment.id),
    staleTime: 4 * 60 * 1000,
  });
  if (!attachment.contentType.startsWith('image/')) return null;
  if (!link.data) return null;
  return (
    <img
      src={link.data.url}
      alt={attachment.caption ?? attachment.fileName}
      style={{ maxWidth: '100%', maxHeight: 120, objectFit: 'cover' }}
    />
  );
}

/** Reusable attachment grid with an uploader (spec P1-04 section 5). */
export function AttachmentUploader({
  entityType,
  entityId,
  compression = browserDeps,
}: AttachmentUploaderProps) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState('');
  const key = ['files', entityType, entityId];

  const list = useQuery({ queryKey: key, queryFn: () => filesApi.list(entityType, entityId) });
  const upload = useMutation({
    mutationFn: async (picked: File) =>
      filesApi.upload(entityType, entityId, await compressImage(picked, compression), caption),
    onSuccess: async () => {
      setCaption('');
      if (input.current) input.current.value = '';
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const remove = useMutation({
    mutationFn: (a: Attachment) => filesApi.remove(a.id, a.version),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const open = useMutation({
    mutationFn: async (a: Attachment) => {
      const { url } = await filesApi.url(a.id);
      window.open(url, '_blank', 'noopener');
    },
  });

  const failure = (error: unknown): string =>
    error instanceof ApiError
      ? t(`files.errors.${error.code}`, { defaultValue: error.message })
      : t('common.saveError');
  const error = upload.error ?? remove.error ?? open.error;

  return (
    <div>
      <Typography.Title level={5}>{t('files.title')}</Typography.Title>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      {error && <Alert type="error" message={failure(error)} />}
      {can(filesPermissions.upload) && (
        <Space style={{ marginBottom: 12 }}>
          <Input
            aria-label={t('files.caption')}
            placeholder={t('files.caption')}
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
          />
          <input
            ref={input}
            type="file"
            aria-label={t('files.upload')}
            accept="image/jpeg,image/png,application/pdf,text/csv,.xlsx"
            disabled={upload.isPending}
            onChange={(event) => {
              const picked = event.target.files?.[0];
              if (picked) upload.mutate(picked);
            }}
          />
        </Space>
      )}
      {(list.data?.items.length ?? 0) === 0 && !list.isLoading && (
        <Typography.Paragraph type="secondary">{t('files.empty')}</Typography.Paragraph>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 12,
        }}
      >
        {list.data?.items.map((attachment) => (
          <Card key={attachment.id} size="small" title={attachment.fileName}>
            <Thumbnail attachment={attachment} />
            {attachment.caption && (
              <Typography.Paragraph>{attachment.caption}</Typography.Paragraph>
            )}
            <Space>
              <Button
                size="small"
                aria-label={t('files.open') + ' ' + attachment.fileName}
                onClick={() => open.mutate(attachment)}
              >
                {t('files.open')}
              </Button>
              {can(filesPermissions.remove) && (
                <Button
                  size="small"
                  danger
                  aria-label={t('files.remove') + ' ' + attachment.fileName}
                  onClick={() => remove.mutate(attachment)}
                >
                  {t('files.remove')}
                </Button>
              )}
            </Space>
          </Card>
        ))}
      </div>
    </div>
  );
}
