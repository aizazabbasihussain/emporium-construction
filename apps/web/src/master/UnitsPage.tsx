import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Select, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { masterdataPermissions, unitKinds } from '@emporium/shared';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { masterApi, type Conversion, type Unit } from './api';
import { CrudPage, type Field } from './CrudPage';
import { decimalRule, options } from './rules';

interface ConvertValues {
  quantity: string;
  from: string;
  to: string;
}

export function UnitsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(masterdataPermissions.itemManage);
  const units = useQuery({
    queryKey: ['master-units', 'all'],
    queryFn: () => masterApi.listAll<Unit>('/master/units'),
  });
  const unitOptions = (units.data ?? []).map((u) => ({
    value: u.code,
    label: `${u.code} ${u.name}`,
  }));

  const unitFields: Field[] = [
    { name: 'code', label: 'master.units.code', required: true, lockedOnEdit: true },
    { name: 'name', label: 'master.units.name', required: true },
    {
      name: 'kind',
      label: 'master.units.kind',
      type: 'select',
      required: true,
      options: options(unitKinds, (k) => t(`master.units.kinds.${k}`)),
    },
  ];
  const conversionFields: Field[] = [
    {
      name: 'fromUnit',
      label: 'master.units.from',
      type: 'select',
      required: true,
      options: unitOptions,
      lockedOnEdit: true,
    },
    {
      name: 'toUnit',
      label: 'master.units.to',
      type: 'select',
      required: true,
      options: unitOptions,
      lockedOnEdit: true,
    },
    { name: 'factor', label: 'master.units.factor', required: true, rules: [decimalRule(t)] },
  ];

  const [converter] = Form.useForm<ConvertValues>();
  const convert = useMutation({
    mutationFn: (values: ConvertValues) =>
      masterApi.convert(values.quantity, values.from, values.to),
  });
  let convertError: string | null = null;
  if (convert.error instanceof ApiError) {
    convertError = t(`master.errors.${convert.error.code}`, {
      defaultValue: convert.error.message,
    });
  } else if (convert.isError) {
    convertError = t('common.loadError');
  }

  return (
    <div>
      <CrudPage<Unit>
        title="master.units.title"
        path="/master/units"
        queryKey="master-units"
        idOf={(row) => row.code}
        nameOf={(row) => row.code}
        canManage={canManage}
        fields={unitFields}
        columns={[
          { title: t('master.units.code'), dataIndex: 'code' },
          { title: t('master.units.name'), dataIndex: 'name' },
          {
            title: t('master.units.kind'),
            render: (_, row) => t(`master.units.kinds.${row.kind}`),
          },
        ]}
      />
      <CrudPage<Conversion>
        title="master.units.conversions"
        path="/master/unit-conversions"
        queryKey="master-unit-conversions"
        idOf={(row) => row.id}
        nameOf={(row) => `${row.fromUnit}-${row.toUnit}`}
        canManage={canManage}
        fields={conversionFields}
        columns={[
          { title: t('master.units.from'), dataIndex: 'fromUnit' },
          { title: t('master.units.to'), dataIndex: 'toUnit' },
          { title: t('master.units.factor'), dataIndex: 'factor' },
        ]}
      />
      <Typography.Title level={4}>{t('master.units.converter')}</Typography.Title>
      <Form form={converter} layout="inline" onFinish={(values) => convert.mutate(values)}>
        <Form.Item
          name="quantity"
          label={t('master.units.quantity')}
          rules={[{ required: true, message: t('common.required') }, decimalRule(t)]}
        >
          <Input style={{ width: 120 }} />
        </Form.Item>
        <Form.Item
          name="from"
          label={t('master.units.from')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Select
            aria-label={t('master.units.from')}
            style={{ width: 160 }}
            options={unitOptions}
          />
        </Form.Item>
        <Form.Item
          name="to"
          label={t('master.units.to')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Select aria-label={t('master.units.to')} style={{ width: 160 }} options={unitOptions} />
        </Form.Item>
        <Button htmlType="submit">{t('master.units.convert')}</Button>
      </Form>
      <Space style={{ marginTop: 8 }}>
        {convert.data && (
          <Alert
            type="success"
            message={t('master.units.result', {
              quantity: convert.data.quantity,
              unit: convert.data.unit,
            })}
          />
        )}
        {convertError && <Alert type="error" message={convertError} />}
      </Space>
    </div>
  );
}
