import { leadSectors, leadWorkTypes } from '@emporium/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Select, Space } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { phoneRule } from '../master/rules';
import { crmApi, type CrmReference, type Lead } from './api';

export interface LeadFormProps {
  open: boolean;
  /** The lead to edit; without it a new lead is created. */
  lead?: Lead | undefined;
  reference: CrmReference;
  onClose: () => void;
  onSaved?: (lead: Lead) => void;
}

type Values = Record<string, string | undefined>;

const blank = (value: string | undefined): string | null =>
  value === undefined || value.trim() === '' ? null : value.trim();

/** Create or edit a lead (BR-1, BR-6). Rules are hints only; the API checks them again. */
export function LeadForm({ open, lead, reference, onClose, onSaved }: LeadFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<Values>();
  const [error, setError] = useState<string | null>(null);
  const closed = lead !== undefined && lead.stageKind !== 'open';

  const save = useMutation({
    mutationFn: (values: Values) => {
      const body = {
        partyId: lead?.partyId ?? null,
        contactName: blank(values.contactName),
        contactPhone: blank(values.contactPhone),
        workType: values.workType,
        sector: values.sector,
        siteAddress: blank(values.siteAddress),
        description: blank(values.description),
        expectedValue: blank(values.expectedValue),
        sourceCode: values.sourceCode,
        locationId: lead?.locationId ?? null,
      };
      return lead === undefined
        ? crmApi.createLead(body)
        : crmApi.updateLead(lead.id, { ...body, version: lead.version });
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['crm'] });
      setError(null);
      onSaved?.(saved);
      onClose();
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`crm.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  const initial: Values =
    lead === undefined
      ? { workType: 'new_build', sector: 'private' }
      : {
          contactName: lead.contactName ?? undefined,
          contactPhone: lead.contactPhone ?? undefined,
          workType: lead.workType,
          sector: lead.sector,
          siteAddress: lead.siteAddress ?? undefined,
          description: lead.description ?? undefined,
          expectedValue: lead.expectedValue ?? undefined,
          sourceCode: lead.sourceCode,
        };

  const required = [{ required: true, message: t('common.required') }];
  const contactRequired = lead?.partyId ? [] : required;

  return (
    <Modal
      open={open}
      title={t(lead === undefined ? 'crm.lead.new' : 'crm.lead.edit')}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={initial}>
        {closed && <Alert type="info" message={t('crm.lead.closedNotesOnly')} />}
        <Form.Item name="contactName" label={t('crm.lead.contactName')} rules={contactRequired}>
          <Input disabled={closed} />
        </Form.Item>
        <Form.Item
          name="contactPhone"
          label={t('crm.lead.contactPhone')}
          rules={[...contactRequired, phoneRule(t)]}
        >
          <Input disabled={closed} />
        </Form.Item>
        <Form.Item name="workType" label={t('crm.lead.workType')} rules={required}>
          <Select
            aria-label={t('crm.lead.workType')}
            disabled={closed}
            options={leadWorkTypes.map((value) => ({
              value,
              label: t(`crm.workType.${value}`),
            }))}
          />
        </Form.Item>
        <Form.Item name="sector" label={t('crm.lead.sector')} rules={required}>
          <Select
            aria-label={t('crm.lead.sector')}
            disabled={closed}
            options={leadSectors.map((value) => ({ value, label: t(`crm.sector.${value}`) }))}
          />
        </Form.Item>
        <Form.Item name="sourceCode" label={t('crm.lead.source')} rules={required}>
          <Select
            aria-label={t('crm.lead.source')}
            disabled={closed}
            options={reference.sources.map((source) => ({
              value: source.code,
              label: source.name,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="expectedValue"
          label={t('crm.lead.expectedValue')}
          rules={[{ pattern: /^\d{1,16}(\.\d{1,2})?$/, message: t('crm.validation.amount') }]}
        >
          <Input disabled={closed} />
        </Form.Item>
        <Form.Item name="siteAddress" label={t('crm.lead.siteAddress')}>
          <Input disabled={closed} />
        </Form.Item>
        <Form.Item name="description" label={t('crm.lead.description')}>
          <Input.TextArea rows={3} />
        </Form.Item>
        {error !== null && <Alert type="error" message={error} />}
        <Space style={{ marginTop: 12 }}>
          <Button
            type="primary"
            loading={save.isPending}
            onClick={() =>
              void form.validateFields().then(
                (values) => save.mutate(values),
                () => undefined,
              )
            }
          >
            {t('common.save')}
          </Button>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
        </Space>
      </Form>
    </Modal>
  );
}
