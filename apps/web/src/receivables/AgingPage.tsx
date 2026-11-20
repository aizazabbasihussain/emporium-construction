import { formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Segmented, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { receivablesApi, type Aging } from './api';

type AgingRow = Aging['rows'][number];

const today = () => new Date().toISOString().slice(0, 10);

/** Aging per customer or per project as of any date (BR-8). */
export function AgingPage() {
  const { t } = useTranslation();
  const [asOf, setAsOf] = useState(today());
  const [groupBy, setGroupBy] = useState<'customer' | 'project'>('customer');
  const report = useQuery({
    queryKey: ['receivables', 'aging', asOf, groupBy],
    queryFn: () => receivablesApi.aging(asOf, groupBy),
    enabled: asOf !== '',
  });
  const data = report.data;
  const label = (value: string, index: number) =>
    index === 0 ? t('receivables.aging.current') : value;

  return (
    <div>
      <Typography.Title level={3}>{t('receivables.aging.title')}</Typography.Title>
      <Space style={{ marginBottom: 12 }}>
        <Input
          aria-label={t('receivables.aging.asOf')}
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
        <Segmented
          aria-label={t('receivables.aging.group')}
          value={groupBy}
          onChange={(value) => setGroupBy(value as 'customer' | 'project')}
          options={[
            { value: 'customer', label: t('receivables.aging.byCustomer') },
            { value: 'project', label: t('receivables.aging.byProject') },
          ]}
        />
      </Space>
      {report.isError && <Alert type="error" message={t('common.loadError')} />}
      {data !== undefined && (
        <Table<AgingRow>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={data.rows}
          columns={[
            {
              title: t(
                groupBy === 'customer'
                  ? 'receivables.common.customer'
                  : 'receivables.aging.byProject',
              ),
              render: (_, row) => row.label,
            },
            ...data.labels.map((name, index) => ({
              title: label(name, index),
              align: 'right' as const,
              render: (_: unknown, row: AgingRow) => formatAmount(row.buckets[index] as string),
            })),
            {
              title: t('receivables.aging.total'),
              align: 'right' as const,
              render: (_: unknown, row: AgingRow) => formatAmount(row.total),
            },
          ]}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>{t('receivables.aging.total')}</Table.Summary.Cell>
              {data.totals.map((value, index) => (
                <Table.Summary.Cell key={data.labels[index]} index={index + 1} align="right">
                  {formatAmount(value)}
                </Table.Summary.Cell>
              ))}
              <Table.Summary.Cell index={data.totals.length + 1} align="right">
                <strong>{formatAmount(data.total)}</strong>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      )}
    </div>
  );
}
