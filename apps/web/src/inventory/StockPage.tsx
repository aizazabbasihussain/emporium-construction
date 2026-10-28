import { useQuery } from '@tanstack/react-query';
import { Alert, Select, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { inventoryApi, type Stock } from './api';
import { useInventoryReferences } from './references';

/** Stock on hand by store and item, company and client-owned side by side (BR-5). */
export function StockPage() {
  const { t } = useTranslation();
  const refs = useInventoryReferences();
  const [storeId, setStoreId] = useState<string | undefined>(undefined);
  const [itemId, setItemId] = useState<string | undefined>(undefined);
  const stock = useQuery({
    queryKey: ['inventory-stock', storeId ?? '', itemId ?? ''],
    queryFn: () => inventoryApi.stock({ storeId, itemId }),
  });

  return (
    <div>
      <Typography.Title level={3}>{t('inventory.stock.title')}</Typography.Title>
      {stock.isError && <Alert type="error" message={t('common.loadError')} />}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '12px 0' }}>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          aria-label={t('inventory.field.store')}
          placeholder={t('inventory.stock.allStores')}
          style={{ width: 240 }}
          value={storeId}
          onChange={(value: string | undefined) => setStoreId(value)}
          options={refs.storeOptions}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          aria-label={t('inventory.field.item')}
          placeholder={t('inventory.stock.allItems')}
          style={{ width: 240 }}
          value={itemId}
          onChange={(value: string | undefined) => setItemId(value)}
          options={refs.itemOptions}
        />
        <Link to="/inventory/issue">{t('inventory.stock.issueLink')}</Link>
      </div>
      <Table<Stock>
        rowKey={(row) => `${row.storeId}:${row.itemId}:${row.ownership}:${row.ownerPartyId ?? ''}`}
        loading={stock.isLoading}
        pagination={false}
        dataSource={stock.data?.items ?? []}
        columns={[
          { title: t('inventory.field.item'), render: (_, row) => refs.itemName(row.itemId) },
          { title: t('inventory.field.store'), render: (_, row) => refs.storeName(row.storeId) },
          {
            title: t('inventory.field.ownership'),
            render: (_, row) => t(`inventory.ownership.${row.ownership}`),
          },
          { title: t('inventory.field.quantity'), dataIndex: 'quantity', align: 'right' },
        ]}
      />
    </div>
  );
}
