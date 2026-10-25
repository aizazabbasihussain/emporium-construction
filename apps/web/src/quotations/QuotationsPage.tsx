import { formatAmount, quotationStatuses, quotationsPermissions } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { quotationsApi, type QuotationHeader } from './api';
import { NewQuotationDialog } from './NewQuotationDialog';

const PAGE_SIZE = 20;

export function QuotationsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const quotations = useQuery({
    queryKey: ['quotations', 'list', text, status, page],
    queryFn: () =>
      quotationsApi.list({
        q: text.trim() === '' ? undefined : text.trim(),
        status,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
  });

  return (
    <div>
      <Typography.Title level={3}>{t('quotations.title')}</Typography.Title>
      {quotations.isError && <Alert type="error" message={t('common.loadError')} />}
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
          aria-label={t('quotations.field.status')}
          placeholder={t('quotations.field.status')}
          allowClear
          style={{ width: 200 }}
          value={status}
          onChange={(value: string | undefined) => {
            setStatus(value);
            setPage(1);
          }}
          options={quotationStatuses.map((value) => ({
            value,
            label: t(`quotations.status.${value}`),
          }))}
        />
        {can(quotationsPermissions.create) && (
          <Button type="primary" onClick={() => setCreating(true)}>
            {t('quotations.new')}
          </Button>
        )}
      </Space>
      <Table<QuotationHeader>
        rowKey="id"
        loading={quotations.isLoading}
        dataSource={quotations.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: quotations.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          {
            title: t('quotations.field.number'),
            render: (_, row) => <Link to={`/quotations/${row.id}`}>{row.displayNumber}</Link>,
          },
          { title: t('quotations.field.title'), dataIndex: 'title' },
          {
            title: t('quotations.field.status'),
            render: (_, row) => <Tag>{t(`quotations.status.${row.status}`)}</Tag>,
          },
          {
            title: t('quotations.field.price'),
            align: 'right',
            render: (_, row) => formatAmount(row.price),
          },
        ]}
      />
      {creating && (
        <NewQuotationDialog
          open
          onClose={() => setCreating(false)}
          onCreated={(quotation) => {
            setCreating(false);
            void navigate(`/quotations/${quotation.id}`);
          }}
        />
      )}
    </div>
  );
}
