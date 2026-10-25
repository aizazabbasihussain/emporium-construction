import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate, masterdataPermissions, registrationTypes } from '@emporium/shared';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { masterApi, type Company, type Registration } from './api';
import { CrudPage, type Field } from './CrudPage';
import { dateRule, options, phoneRule } from './rules';

export function CompanyPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(masterdataPermissions.companyManage);
  const queryClient = useQueryClient();
  const [form] = Form.useForm<Record<string, unknown>>();
  const [saved, setSaved] = useState(false);
  const company = useQuery({
    queryKey: ['master-company'],
    queryFn: async (): Promise<Company | null> => {
      try {
        return await masterApi.company();
      } catch (error) {
        // No profile yet is a normal first-run state, not a failure.
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
  useEffect(() => {
    if (company.data) form.setFieldsValue({ ...company.data });
  }, [company.data, form]);

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      masterApi.saveCompany({
        ...values,
        ...(company.data ? { version: company.data.version } : {}),
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['master-company'] });
    },
  });
  let failure: string | null = null;
  if (save.error instanceof ApiError) {
    failure = t(`master.errors.${save.error.code}`, { defaultValue: save.error.message });
  } else if (save.isError) {
    failure = t('common.saveError');
  }

  const registrationFields: Field[] = [
    { name: 'authority', label: 'master.company.authority', required: true },
    {
      name: 'registrationType',
      label: 'master.company.registrationType',
      type: 'select',
      required: true,
      options: options(registrationTypes, (r) => r.toUpperCase()),
    },
    { name: 'number', label: 'master.company.number', required: true },
    { name: 'validFrom', label: 'master.company.validFrom', required: true, rules: [dateRule(t)] },
    { name: 'validTo', label: 'master.company.validTo', rules: [dateRule(t)] },
  ];

  return (
    <div>
      <Typography.Title level={3}>{t('master.company.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('master.company.hint')}</Typography.Paragraph>
      {company.isError && <Alert type="error" message={t('common.loadError')} />}
      <Form
        form={form}
        layout="vertical"
        disabled={!canManage}
        onFinish={(values) => {
          setSaved(false);
          save.mutate(values);
        }}
        style={{ maxWidth: 480 }}
      >
        <Form.Item
          name="name"
          label={t('master.company.name')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Input />
        </Form.Item>
        <Form.Item name="address" label={t('master.company.address')}>
          <Input />
        </Form.Item>
        <Form.Item name="phone" label={t('master.company.phone')} rules={[phoneRule(t)]}>
          <Input />
        </Form.Item>
        <Form.Item name="email" label={t('master.company.email')} rules={[{ type: 'email' }]}>
          <Input />
        </Form.Item>
        {failure && <Alert type="error" message={failure} />}
        {saved && <Alert type="success" message={t('master.company.saved')} />}
        {canManage && (
          <Button htmlType="submit" type="primary" loading={save.isPending}>
            {t('common.save')}
          </Button>
        )}
      </Form>
      <CrudPage<Registration>
        title="master.company.registrations"
        path="/master/tax-registrations"
        queryKey="master-tax-registrations"
        idOf={(row) => row.id}
        nameOf={(row) => `${row.authority} ${row.registrationType}`}
        canManage={canManage}
        defaults={{ authority: 'FBR', registrationType: 'ntn' }}
        fields={registrationFields}
        toBody={(values) => ({
          ...values,
          validTo: values.validTo === '' ? null : (values.validTo ?? null),
        })}
        columns={[
          { title: t('master.company.authority'), dataIndex: 'authority' },
          {
            title: t('master.company.registrationType'),
            render: (_, row) => row.registrationType.toUpperCase(),
          },
          { title: t('master.company.number'), dataIndex: 'number' },
          { title: t('master.company.validFrom'), render: (_, row) => formatDate(row.validFrom) },
          {
            title: t('master.company.validTo'),
            render: (_, row) => (row.validTo ? formatDate(row.validTo) : ''),
          },
        ]}
      />
    </div>
  );
}
