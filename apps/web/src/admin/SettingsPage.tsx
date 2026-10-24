import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, InputNumber, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { adminApi, ApiError } from './api';

export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const setting = useQuery({
    queryKey: ['setting', 'backdating_days'],
    queryFn: () => adminApi.setting('backdating_days'),
  });
  const save = useMutation({
    mutationFn: (value: number) =>
      adminApi.saveSetting('backdating_days', value, setting.data?.version ?? 0),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['setting'] }),
  });

  if (setting.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (!setting.data) return null;

  return (
    <div>
      <Typography.Title level={3}>{t('admin.settings.title')}</Typography.Title>
      <Form
        key={setting.data.version}
        layout="vertical"
        initialValues={{ backdatingDays: setting.data.value }}
        onFinish={(values: { backdatingDays: number }) => save.mutate(values.backdatingDays)}
      >
        <Form.Item
          name="backdatingDays"
          label={t('admin.settings.backdatingDays')}
          extra={t('admin.settings.backdatingHint')}
          rules={[
            { required: true, message: t('common.required') },
            {
              type: 'integer',
              min: 0,
              max: 365,
              message: t('admin.settings.integerRequired'),
            },
          ]}
        >
          <InputNumber precision={0} />
        </Form.Item>
        {save.isError && (
          <Alert
            type="error"
            message={
              save.error instanceof ApiError && save.error.status === 409
                ? t('admin.settings.conflict')
                : t('common.saveError')
            }
          />
        )}
        {save.isSuccess && <Alert type="success" message={t('common.saved')} />}
        <Button htmlType="submit" type="primary" loading={save.isPending}>
          {t('common.save')}
        </Button>
      </Form>
    </div>
  );
}
