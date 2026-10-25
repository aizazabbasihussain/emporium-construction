import { estimationPermissions, formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { estimationApi, type EstimateHeader } from './api';
import { NewEstimateDialog } from './NewEstimateDialog';

const PAGE_SIZE = 20;

export function EstimatesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const estimates = useQuery({
    queryKey: ['estimation', 'estimates', text, status, page],
    queryFn: () =>
      estimationApi.estimates({
        q: text.trim() === '' ? undefined : text.trim(),
        status,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
  });

  return (
    <div>
      <Typography.Title level={3}>{t('estimation.estimates.title')}</Typography.Title>
      {estimates.isError && <Alert type="error" message={t('common.loadError')} />}
      <Space style={{ margin: '12px 0' }} wrap>
        <Input.Search
          aria-label={t('common.search')}
          placeholder={t('common.search')}
          allowClear
          onSearch={(value) => {
            setText(value);
            setPage(1);
          }}
        />
        <Select
          aria-label={t('estimation.field.status')}
          placeholder={t('estimation.field.status')}
          allowClear
          style={{ width: 160 }}
          value={status}
          onChange={(value: string | undefined) => {
            setStatus(value);
            setPage(1);
          }}
          options={(['draft', 'locked', 'superseded'] as const).map((value) => ({
            value,
            label: t(`estimation.status.${value}`),
          }))}
        />
        {can(estimationPermissions.estimateCreate) && (
          <Button type="primary" onClick={() => setCreating(true)}>
            {t('estimation.estimates.new')}
          </Button>
        )}
      </Space>
      <Table<EstimateHeader>
        rowKey="id"
        loading={estimates.isLoading}
        dataSource={estimates.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: estimates.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          {
            title: t('estimation.field.number'),
            render: (_, row) => (
              <Link to={`/estimation/estimates/${row.id}`}>
                {row.number} / {row.revision}
              </Link>
            ),
          },
          { title: t('estimation.field.title'), dataIndex: 'title' },
          {
            title: t('estimation.workType.label'),
            render: (_, row) => t(`estimation.workType.${row.workType}`),
          },
          {
            title: t('estimation.field.status'),
            render: (_, row) => (
              <Tag color={row.status === 'locked' ? 'green' : 'default'}>
                {t(`estimation.status.${row.status}`)}
              </Tag>
            ),
          },
          {
            title: t('estimation.field.price'),
            align: 'right',
            render: (_, row) => (row.proposedPrice === null ? '' : formatAmount(row.proposedPrice)),
          },
        ]}
      />
      {creating && (
        <NewEstimateDialog
          open
          onClose={() => setCreating(false)}
          onCreated={(estimate) => {
            setCreating(false);
            void navigate(`/estimation/estimates/${estimate.id}`);
          }}
        />
      )}
    </div>
  );
}
