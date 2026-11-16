import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Input, Modal, Select, Space } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { estimationApi } from '../estimation/api';
import { masterApi, type Party } from '../master/api';
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
  const [partyId, setPartyId] = useState<string | undefined>(undefined);
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const estimates = useQuery({
    queryKey: ['estimation', 'estimates', 'locked'],
    queryFn: () => estimationApi.estimates({ status: 'locked', limit: 200 }),
  });

  const clients = useQuery({
    queryKey: ['master-parties', 'clients'],
    queryFn: () => masterApi.list<Party>('/master/parties', { role: 'client', limit: 200 }),
  });

  const create = useMutation({
    mutationFn: () =>
      quotationsApi.create({
        estimateId,
        partyId,
        price: price.trim(),
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
        else if (partyId === undefined) setError(t('quotations.newDialog.clientRequired'));
        else if (price.trim() === '') setError(t('quotations.newDialog.priceRequired'));
        else create.mutate();
      }}
      okText={t('quotations.newDialog.create')}
      cancelText={t('common.cancel')}
      confirmLoading={create.isPending}
      destroyOnClose
    >
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select
          aria-label={t('quotations.newDialog.estimate')}
          placeholder={t('quotations.newDialog.estimate')}
          style={{ width: '100%' }}
          value={estimateId}
          onChange={(id: string) => {
            setEstimateId(id);
            // The estimate's own client is the starting choice; it can be changed here.
            const chosen = estimates.data?.items.find((row) => row.id === id);
            setPartyId(chosen?.partyId ?? undefined);
            setPrice(chosen?.proposedPrice ?? '');
          }}
          options={(estimates.data?.items ?? []).map((row) => ({
            value: row.id,
            label: `${row.number} / ${row.revision} - ${row.title}`,
          }))}
        />
        <Select
          showSearch
          optionFilterProp="label"
          aria-label={t('quotations.newDialog.client')}
          placeholder={t('quotations.newDialog.client')}
          style={{ width: '100%' }}
          value={partyId}
          onChange={setPartyId}
          options={(clients.data?.items ?? []).map((party) => ({
            value: party.id,
            label: party.name,
          }))}
        />
        <Input
          aria-label={t('quotations.newDialog.price')}
          placeholder={t('quotations.newDialog.price')}
          addonBefore={t('quotations.newDialog.price')}
          inputMode="decimal"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </Space>
    </Modal>
  );
}
