import { crmPermissions, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { crmApi, type FollowUp } from './api';

const PAGE_SIZE = 20;

/** The follow-up list with overdue ones flagged (BR-5). */
export function FollowUpsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('open');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['crm', 'follow-ups', status, page],
    queryFn: () => crmApi.followUps({ status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  });
  const done = useMutation({
    mutationFn: (followUp: FollowUp) => crmApi.completeFollowUp(followUp.id, followUp.version),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['crm'] }),
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`crm.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  return (
    <div>
      <Typography.Title level={3}>{t('crm.followUp.listTitle')}</Typography.Title>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      {error !== null && <Alert type="error" message={error} />}
      <Space style={{ margin: '12px 0' }}>
        <Select
          aria-label={t('crm.followUp.statusLabel')}
          style={{ width: 180 }}
          value={status}
          onChange={(value: string) => {
            setStatus(value);
            setPage(1);
          }}
          options={['open', 'done', 'cancelled'].map((value) => ({
            value,
            label: t(`crm.followUp.status.${value}`),
          }))}
        />
      </Space>
      <Table<FollowUp>
        rowKey="id"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: list.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          {
            title: t('crm.lead.number'),
            render: (_, row) => <Link to={`/crm/leads/${row.leadId}`}>{row.leadNumber}</Link>,
          },
          { title: t('crm.followUp.dueDate'), render: (_, row) => formatDate(row.dueDate) },
          { title: t('crm.followUp.note'), dataIndex: 'note' },
          {
            title: t('crm.followUp.statusLabel'),
            render: (_, row) => (
              <Space>
                {t(`crm.followUp.status.${row.status}`)}
                {row.overdue && <Tag color="red">{t('crm.followUp.overdue')}</Tag>}
              </Space>
            ),
          },
          {
            title: '',
            render: (_, row) =>
              row.status === 'open' && can(crmPermissions.followupManage) ? (
                <Button size="small" onClick={() => done.mutate(row)}>
                  {t('crm.followUp.markDone')} {row.leadNumber}
                </Button>
              ) : null,
          },
        ]}
      />
    </div>
  );
}
