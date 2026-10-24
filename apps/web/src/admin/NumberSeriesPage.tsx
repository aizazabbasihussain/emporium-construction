import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Form, Input, InputNumber, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi, type SeriesItem } from './api';

type FormValues = Omit<SeriesItem, 'version'>;

const blank: FormValues = {
  code: '',
  prefix: '',
  padding: 4,
  resetYearly: true,
  gapless: false,
  startValue: 1,
  nextValue: 1,
};

/** Display-only preview of the number format; the API allocates the real numbers. */
const preview = (v: FormValues) =>
  v.resetYearly
    ? `${v.prefix}-YYYY-${String(v.nextValue).padStart(v.padding, '0')}`
    : `${v.prefix}-${String(v.nextValue).padStart(v.padding, '0')}`;

export function NumberSeriesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<SeriesItem | null>(null);
  const list = useQuery({ queryKey: ['series'], queryFn: () => adminApi.series() });
  const save = useMutation({
    mutationFn: (values: FormValues) =>
      adminApi.saveSeries(editing ? { ...values, version: editing.version } : values),
    onSuccess: async () => {
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['series'] });
    },
  });
  const [form] = Form.useForm<FormValues>();

  const startEdit = (series: SeriesItem | null) => {
    setEditing(series);
    form.setFieldsValue(series ?? blank);
  };

  return (
    <div>
      <Typography.Title level={3}>{t('admin.series.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('admin.series.hint')}</Typography.Paragraph>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<SeriesItem>
        rowKey="code"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={false}
        columns={[
          { title: t('admin.series.code'), dataIndex: 'code' },
          { title: t('admin.series.preview'), render: (_, r) => preview(r) },
          {
            title: t('admin.series.gapless'),
            render: (_, r) => (r.gapless ? '✓' : ''),
          },
          {
            title: '',
            render: (_, r) => (
              <Button onClick={() => startEdit(r)}>
                {t('admin.series.edit')} {r.code}
              </Button>
            ),
          },
        ]}
      />
      <Button onClick={() => startEdit(null)}>{t('admin.series.add')}</Button>
      <Form
        form={form}
        layout="vertical"
        initialValues={blank}
        onFinish={(values) => save.mutate(values)}
      >
        <Form.Item
          name="code"
          label={t('admin.series.code')}
          rules={[
            { required: true, message: t('common.required') },
            { pattern: /^[a-z0-9_]+$/, message: t('admin.series.codeFormat') },
          ]}
        >
          <Input disabled={editing !== null} />
        </Form.Item>
        <Form.Item
          name="prefix"
          label={t('admin.series.prefix')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          name="padding"
          label={t('admin.series.padding')}
          rules={[
            { required: true, message: t('common.required') },
            { type: 'integer', min: 1, max: 12, message: t('admin.series.paddingRange') },
          ]}
        >
          <InputNumber precision={0} />
        </Form.Item>
        <Form.Item name="startValue" label={t('admin.series.startValue')}>
          <InputNumber min={0} precision={0} />
        </Form.Item>
        <Form.Item name="nextValue" label={t('admin.series.nextValue')}>
          <InputNumber min={0} precision={0} />
        </Form.Item>
        <Form.Item name="resetYearly" valuePropName="checked">
          <Checkbox>{t('admin.series.resetYearly')}</Checkbox>
        </Form.Item>
        <Form.Item name="gapless" valuePropName="checked">
          <Checkbox>{t('admin.series.gapless')}</Checkbox>
        </Form.Item>
        {save.isError && <Alert type="error" message={t('common.saveError')} />}
        <Button htmlType="submit" type="primary" loading={save.isPending}>
          {t('common.save')}
        </Button>
      </Form>
    </div>
  );
}
