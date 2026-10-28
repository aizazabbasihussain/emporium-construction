import { useQuery } from '@tanstack/react-query';
import { Alert, Select, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inventoryApi, type ClientMaterial } from './api';
import { useInventoryReferences } from './references';

/** Reconciliation of the material a client brought to a project: received, used, returned, balance (BR-5). */
export function ClientMaterialPage() {
  const { t } = useTranslation();
  const refs = useInventoryReferences();
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const rows = useQuery({
    queryKey: ['inventory-client-material', projectId ?? ''],
    queryFn: () => inventoryApi.clientMaterial(projectId as string),
    enabled: projectId !== undefined,
  });

  return (
    <div>
      <Typography.Title level={3}>{t('inventory.client.title')}</Typography.Title>
      {rows.isError && <Alert type="error" message={t('common.loadError')} />}
      <Select
        showSearch
        optionFilterProp="label"
        aria-label={t('inventory.field.project')}
        placeholder={t('inventory.client.pickProject')}
        style={{ width: 320, margin: '12px 0' }}
        value={projectId}
        onChange={(value: string) => setProjectId(value)}
        options={refs.projectOptions}
      />
      <Table<ClientMaterial>
        rowKey={(row) => `${row.storeId}:${row.itemId}`}
        loading={rows.isLoading}
        pagination={false}
        dataSource={rows.data ?? []}
        columns={[
          { title: t('inventory.field.item'), render: (_, row) => refs.itemName(row.itemId) },
          { title: t('inventory.field.store'), render: (_, row) => refs.storeName(row.storeId) },
          { title: t('inventory.client.received'), dataIndex: 'received', align: 'right' },
          { title: t('inventory.client.used'), dataIndex: 'used', align: 'right' },
          { title: t('inventory.client.returned'), dataIndex: 'returned', align: 'right' },
          { title: t('inventory.client.balance'), dataIndex: 'balance', align: 'right' },
        ]}
      />
    </div>
  );
}
