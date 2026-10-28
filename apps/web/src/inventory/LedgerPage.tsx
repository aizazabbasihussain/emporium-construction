import { formatAmount, inventoryMovementTypes, type InventoryMovementType } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Select, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inventoryApi, type LedgerRow } from './api';
import { useInventoryReferences } from './references';

/** The append-only stock ledger with the filters a storekeeper needs. */
export function LedgerPage() {
  const { t } = useTranslation();
  const refs = useInventoryReferences();
  const [storeId, setStoreId] = useState<string | undefined>(undefined);
  const [itemId, setItemId] = useState<string | undefined>(undefined);
  const [movementType, setMovementType] = useState<InventoryMovementType | undefined>(undefined);
  const ledger = useQuery({
    queryKey: ['inventory-ledger', storeId ?? '', itemId ?? '', movementType ?? ''],
    queryFn: () => inventoryApi.ledger({ storeId, itemId, movementType }),
  });

  return (
    <div>
      <Typography.Title level={3}>{t('inventory.ledger.title')}</Typography.Title>
      {ledger.isError && <Alert type="error" message={t('common.loadError')} />}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '12px 0' }}>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          aria-label={t('inventory.field.store')}
          placeholder={t('inventory.stock.allStores')}
          style={{ width: 220 }}
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
          style={{ width: 220 }}
          value={itemId}
          onChange={(value: string | undefined) => setItemId(value)}
          options={refs.itemOptions}
        />
        <Select
          allowClear
          aria-label={t('inventory.ledger.movement')}
          placeholder={t('inventory.ledger.allMovements')}
          style={{ width: 200 }}
          value={movementType}
          onChange={(value: InventoryMovementType | undefined) => setMovementType(value)}
          options={inventoryMovementTypes.map((type) => ({
            value: type,
            label: t(`inventory.movement.${type}`),
          }))}
        />
      </div>
      <Table<LedgerRow>
        rowKey="id"
        loading={ledger.isLoading}
        pagination={false}
        dataSource={ledger.data?.items ?? []}
        columns={[
          { title: t('inventory.field.date'), dataIndex: 'businessDate' },
          {
            title: t('inventory.ledger.movement'),
            render: (_, row) => t(`inventory.movement.${row.movementType}`),
          },
          { title: t('inventory.field.item'), render: (_, row) => refs.itemName(row.itemId) },
          { title: t('inventory.field.store'), render: (_, row) => refs.storeName(row.storeId) },
          { title: t('inventory.field.quantity'), dataIndex: 'quantity', align: 'right' },
          {
            title: t('inventory.field.value'),
            align: 'right',
            render: (_, row) => (row.value === null ? '' : formatAmount(row.value)),
          },
        ]}
      />
    </div>
  );
}
