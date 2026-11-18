import { formatAmount, formatDate, invoiceStatuses } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Select, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { billingApi, type InvoiceHeader } from './api';

/** Every invoice, newest first, with a filter on status (spec P2-02 section 5). */
export function InvoicesPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const list = useQuery({
    queryKey: ['billing', 'invoices', status],
    queryFn: () => billingApi.invoices({ status }),
  });
  return (
    <div>
      <Typography.Title level={3}>{t('billing.invoices.title')}</Typography.Title>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Select
        aria-label={t('billing.invoice.status')}
        style={{ width: 240, marginBottom: 12 }}
        value={status}
        onChange={setStatus}
        options={[
          { value: '', label: t('billing.invoices.allStatuses') },
          ...invoiceStatuses.map((value) => ({ value, label: t(`billing.status.${value}`) })),
        ]}
      />
      <Table<InvoiceHeader>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('billing.invoices.empty') }}
        dataSource={list.data?.items ?? []}
        columns={[
          {
            title: t('billing.invoice.number'),
            render: (_, row) => (
              <Link to={`/billing/invoices/${row.id}`}>
                {row.number ?? t('billing.invoice.draftNumber')}
              </Link>
            ),
          },
          { title: t('billing.invoice.date'), render: (_, row) => formatDate(row.invoiceDate) },
          { title: t('billing.invoice.due'), render: (_, row) => formatDate(row.dueDate) },
          {
            title: t('billing.invoice.gross'),
            align: 'right',
            render: (_, row) => formatAmount(row.grossTotal),
          },
          {
            title: t('billing.invoice.status'),
            render: (_, row) => <Tag>{t(`billing.status.${row.status}`)}</Tag>,
          },
        ]}
      />
    </div>
  );
}
