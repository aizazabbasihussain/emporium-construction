import { formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Select, Statistic, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { masterApi, type Category, type Item } from '../master/api';
import { valuationApi, type StockValue } from './api';

/** Stock valuation by store and item with the method each is kept in (BR-13). */
export function ValuationReportPage() {
  const { t } = useTranslation();
  const [category, setCategory] = useState<string | undefined>(undefined);

  const report = useQuery({
    queryKey: ['valuation', 'stock-value', category ?? ''],
    queryFn: () => valuationApi.stockValue(category),
  });
  const categories = useQuery({
    queryKey: ['valuation', 'categories'],
    queryFn: () => masterApi.listAll<Category>('/master/item-categories'),
    retry: false,
  });
  const items = useQuery({
    queryKey: ['valuation', 'items'],
    queryFn: () => masterApi.listAll<Item>('/master/items'),
    retry: false,
  });
  const itemName = (id: string) => items.data?.find((item) => item.id === id)?.name ?? id;
  const categoryName = (id: string | null) =>
    categories.data?.find((entry) => entry.id === id)?.name ?? '';

  return (
    <div>
      <Typography.Title level={3}>{t('valuation.report.title')}</Typography.Title>
      {report.isError && <Alert type="error" message={t('common.loadError')} />}
      <Select
        allowClear
        aria-label={t('valuation.report.category')}
        placeholder={t('valuation.report.allCategories')}
        style={{ width: 260, margin: '12px 0' }}
        value={category}
        onChange={(value: string | undefined) => setCategory(value)}
        options={(categories.data ?? []).map((entry) => ({ value: entry.id, label: entry.name }))}
      />
      <Statistic
        title={t('valuation.report.total')}
        value={formatAmount(report.data?.totalValue ?? '0')}
        style={{ marginBottom: 12 }}
      />
      <Table<StockValue>
        rowKey={(row) => `${row.storeId}:${row.itemId}`}
        loading={report.isLoading}
        pagination={false}
        dataSource={report.data?.items ?? []}
        columns={[
          { title: t('valuation.report.item'), render: (_, row) => itemName(row.itemId) },
          { title: t('valuation.report.store'), dataIndex: 'storeId' },
          {
            title: t('valuation.report.category'),
            render: (_, row) => categoryName(row.categoryId),
          },
          {
            title: t('valuation.report.method'),
            render: (_, row) => t(`valuation.method.${row.method}`),
          },
          { title: t('valuation.report.quantity'), dataIndex: 'quantity', align: 'right' },
          {
            title: t('valuation.report.average'),
            align: 'right',
            render: (_, row) => formatAmount(row.averageCost),
          },
          {
            title: t('valuation.report.value'),
            align: 'right',
            render: (_, row) => formatAmount(row.value),
          },
        ]}
      />
    </div>
  );
}
