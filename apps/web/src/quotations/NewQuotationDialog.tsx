import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Modal, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { estimationApi } from '../estimation/api';
import { quotationsApi, type Quotation } from './api';

export interface NewQuotationDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (quotation: Quotation) => void;
}

/** BR-1: a quotation starts from a locked estimate; its price and client come from the estimate. */
export function NewQuotationDialog({ open, onClose, onCreated }: NewQuotationDialogProps) {
  const { t } = useTranslation();
  const [estimateId, setEstimateId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const estimates = useQuery({
    queryKey: ['estimation', 'estimates', 'locked'],
    queryFn: () => estimationApi.estimates({ status: 'locked', limit: 200 }),
  });

  const create = useMutation({
    mutationFn: () =>
      quotationsApi.create({
        estimateId,
        stages: [
          {
            name: t('quotations.newDialog.defaultStage'),
            basis: 'percent',
            percent: '100',
            conditionText: null,
          },
        ],
      }),
    onSuccess: (quotation) => {
      setError(null);
      onCreated(quotation);
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`quotations.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  return (
    <Modal
      open={open}
      title={t('quotations.newDialog.title')}
      onCancel={onClose}
      onOk={() => {
        if (estimateId === undefined) setError(t('quotations.newDialog.incomplete'));
        else create.mutate();
      }}
      okText={t('quotations.newDialog.create')}
      cancelText={t('common.cancel')}
      confirmLoading={create.isPending}
      destroyOnClose
    >
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      <Select
        aria-label={t('quotations.newDialog.estimate')}
        placeholder={t('quotations.newDialog.estimate')}
        style={{ width: '100%' }}
        value={estimateId}
        onChange={setEstimateId}
        options={(estimates.data?.items ?? []).map((row) => ({
          value: row.id,
          label: `${row.number} / ${row.revision} - ${row.title}`,
        }))}
      />
    </Modal>
  );
}
