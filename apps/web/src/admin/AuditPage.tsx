import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi, type AuditItem } from './api';

const formatDate = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

export function AuditPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<{ entityType?: string; entityId?: string }>({});
  const query = useQuery({ queryKey: ['audit', filter], queryFn: () => adminApi.audit(filter) });

  return (
    <div>
      <Typography.Title level={3}>{t('admin.audit.title')}</Typography.Title>
      <Form
        layout="inline"
        onFinish={(values: { entityType?: string; entityId?: string }) =>
          setFilter({
            ...(values.entityType ? { entityType: values.entityType.trim() } : {}),
            ...(values.entityId ? { entityId: values.entityId.trim() } : {}),
          })
        }
      >
        <Form.Item name="entityType" label={t('admin.audit.entityType')}>
          <Input />
        </Form.Item>
        <Form.Item name="entityId" label={t('admin.audit.entityId')}>
          <Input />
        </Form.Item>
        <Button htmlType="submit" type="primary">
          {t('common.search')}
        </Button>
      </Form>
      {query.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<AuditItem>
        rowKey="id"
        loading={query.isLoading}
        dataSource={query.data?.items ?? []}
        pagination={false}
        columns={[
          { title: t('admin.audit.columns.at'), render: (_, r) => formatDate(r.at) },
          { title: t('admin.audit.columns.actor'), dataIndex: 'actor_user_id' },
          { title: t('admin.audit.columns.action'), dataIndex: 'action' },
          {
            title: t('admin.audit.columns.entity'),
            render: (_, r) => `${r.entity_type} ${r.entity_id ?? ''}`.trim(),
          },
          { title: t('admin.audit.columns.request'), dataIndex: 'request_id' },
        ]}
      />
    </div>
  );
}
