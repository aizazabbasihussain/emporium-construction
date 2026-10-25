import { quotationEntityType } from '@emporium/shared';
import { Alert, Input, Modal, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AttachmentUploader } from '../files/AttachmentUploader';

export interface AcceptDialogProps {
  quotationId: string;
  sector: 'government' | 'private';
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (input: { acceptedByName: string; note?: string }) => void;
}

/** BR-6: who accepted; for a government quotation the signed document is attached here first. */
export function AcceptDialog({
  quotationId,
  sector,
  error,
  busy,
  onCancel,
  onConfirm,
}: AcceptDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  return (
    <Modal
      open
      title={t('quotations.accept.title')}
      onCancel={onCancel}
      onOk={() => {
        if (name.trim() === '') {
          setMissing(true);
          return;
        }
        setMissing(false);
        onConfirm({
          acceptedByName: name.trim(),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        });
      }}
      okText={t('quotations.accept.confirm')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {missing && <Alert type="error" message={t('quotations.accept.incomplete')} />}
        {error !== null && <Alert type="error" message={error} />}
        <Input
          aria-label={t('quotations.accept.name')}
          placeholder={t('quotations.accept.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input.TextArea
          aria-label={t('quotations.accept.note')}
          placeholder={t('quotations.accept.note')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Typography.Text type={sector === 'government' ? undefined : 'secondary'}>
          {t('quotations.accept.document')}
          {sector === 'government' ? `: ${t('quotations.accept.documentHint')}` : ''}
        </Typography.Text>
        <AttachmentUploader entityType={quotationEntityType} entityId={quotationId} />
      </Space>
    </Modal>
  );
}

export interface RejectDialogProps {
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/** BR-10: a rejection needs a reason. */
export function RejectDialog({ error, busy, onCancel, onConfirm }: RejectDialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  return (
    <Modal
      open
      title={t('quotations.reject.title')}
      onCancel={onCancel}
      onOk={() => {
        if (reason.trim() === '') {
          setMissing(true);
          return;
        }
        setMissing(false);
        onConfirm(reason.trim());
      }}
      okText={t('quotations.reject.confirm')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {missing && <Alert type="error" message={t('quotations.reject.incomplete')} />}
        {error !== null && <Alert type="error" message={error} />}
        <Input.TextArea
          aria-label={t('quotations.reject.reason')}
          placeholder={t('quotations.reject.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Space>
    </Modal>
  );
}
