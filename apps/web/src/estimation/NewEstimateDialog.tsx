import { estimateSectors } from '@emporium/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Input, Modal, Select, Space } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { estimationApi, type Estimate } from './api';

export interface NewEstimateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (estimate: Estimate) => void;
}

/** BR-2: pick a template, give the parameter values, and the API builds the lines. */
export function NewEstimateDialog({ open, onClose, onCreated }: NewEstimateDialogProps) {
  const { t } = useTranslation();
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [sector, setSector] = useState<string>('private');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ['estimation', 'templates', 'active'],
    queryFn: () => estimationApi.templates({ active: true, limit: 200 }),
  });
  const template = useQuery({
    queryKey: ['estimation', 'template', templateId],
    queryFn: () => estimationApi.template(templateId as string),
    enabled: templateId !== undefined,
  });

  const create = useMutation({
    mutationFn: () =>
      estimationApi.fromTemplate({ templateId, title, sector, parameterValues: values }),
    onSuccess: (estimate) => {
      setError(null);
      onCreated(estimate);
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`estimation.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  const ready = templateId !== undefined && title.trim() !== '';
  return (
    <Modal
      open={open}
      title={t('estimation.new.title')}
      onCancel={onClose}
      onOk={() => {
        if (!ready) setError(t('estimation.new.incomplete'));
        else create.mutate();
      }}
      okText={t('estimation.new.create')}
      cancelText={t('common.cancel')}
      confirmLoading={create.isPending}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {error !== null && <Alert type="error" message={error} />}
        <Select
          aria-label={t('estimation.new.template')}
          placeholder={t('estimation.new.template')}
          style={{ width: '100%' }}
          value={templateId}
          onChange={(value: string) => {
            setTemplateId(value);
            setValues({});
          }}
          options={(templates.data?.items ?? []).map((row) => ({
            value: row.id,
            label: `${row.code} ${row.name}`,
          }))}
        />
        <Input
          aria-label={t('estimation.field.title')}
          placeholder={t('estimation.field.title')}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Select
          aria-label={t('estimation.field.sector')}
          style={{ width: '100%' }}
          value={sector}
          onChange={setSector}
          options={estimateSectors.map((value) => ({
            value,
            label: t(`estimation.sector.${value}`),
          }))}
        />
        {(template.data?.parameters ?? []).map((parameter) => (
          <Input
            key={parameter.key}
            addonBefore={parameter.label}
            addonAfter={parameter.unit}
            aria-label={parameter.label}
            value={values[parameter.key] ?? ''}
            onChange={(event) => setValues({ ...values, [parameter.key]: event.target.value })}
          />
        ))}
      </Space>
    </Modal>
  );
}
