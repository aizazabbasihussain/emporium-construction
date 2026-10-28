import { inventoryPermissions } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { inventoryApi, type Transfer } from './api';
import { useInventoryReferences } from './references';
import { today, useErrorText } from './shared';
import { emptySheetLine, SheetLines, sheetProblem, type SheetLine } from './SheetLines';

/** Transfers between stores: draft, send (stock leaves the source), receive (stock arrives) (BR-4). */
export function TransfersPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const refs = useInventoryReferences();
  const errorText = useErrorText();
  const canTransfer = can(inventoryPermissions.stockTransfer);
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<SheetLine[]>([emptySheetLine()]);
  const [error, setError] = useState<string | null>(null);

  const transfers = useQuery({
    queryKey: ['inventory-transfers'],
    queryFn: inventoryApi.transfers,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['inventory-transfers'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory-stock'] });
  };
  const create = useMutation({
    mutationFn: inventoryApi.createTransfer,
    onSuccess: () => {
      setLines([emptySheetLine()]);
      setError(null);
      refresh();
    },
    onError: (cause) => setError(errorText(cause)),
  });
  const act = useMutation({
    mutationFn: (input: { id: string; action: 'send' | 'receive' | 'cancel'; version: number }) =>
      inventoryApi.transferAction(input.id, input.action, input.version),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const submit = () => {
    const problem = sheetProblem(lines);
    if (from === undefined || to === undefined) {
      setError(t('inventory.transfer.stores'));
      return;
    }
    if (problem !== null) {
      setError(t(problem));
      return;
    }
    create.mutate({
      fromStoreId: from,
      toStoreId: to,
      businessDate: today(),
      lines: lines.map((line) => ({
        itemId: line.itemId as string,
        quantity: line.quantity.trim(),
      })),
    });
  };

  const buttons = (row: Transfer) => {
    const run = (action: 'send' | 'receive' | 'cancel') => (
      <Button
        key={action}
        size="small"
        onClick={() => act.mutate({ id: row.id, action, version: row.version })}
      >
        {t(`inventory.transfer.${action}`)}
      </Button>
    );
    if (row.status === 'draft') return [run('send'), run('cancel')];
    if (row.status === 'in_transit') return [run('receive'), run('cancel')];
    return [];
  };

  return (
    <div>
      <Typography.Title level={3}>{t('inventory.transfer.title')}</Typography.Title>
      {error !== null && (
        <Alert style={{ marginBottom: 12 }} type="error" showIcon message={error} />
      )}
      {canTransfer && (
        <div style={{ maxWidth: 640, marginBottom: 24 }}>
          <Space style={{ marginBottom: 12 }} wrap>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: 240 }}
              aria-label={t('inventory.transfer.from')}
              placeholder={t('inventory.transfer.from')}
              value={from}
              onChange={(value: string) => setFrom(value)}
              options={refs.storeOptions}
            />
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: 240 }}
              aria-label={t('inventory.transfer.to')}
              placeholder={t('inventory.transfer.to')}
              value={to}
              onChange={(value: string) => setTo(value)}
              options={refs.storeOptions}
            />
          </Space>
          <SheetLines
            lines={lines}
            itemOptions={refs.itemOptions}
            quantityLabel={t('inventory.field.quantity')}
            onChange={setLines}
          />
          <Button
            type="primary"
            style={{ marginTop: 12 }}
            loading={create.isPending}
            onClick={submit}
          >
            {t('inventory.transfer.create')}
          </Button>
        </div>
      )}
      <Table<Transfer>
        rowKey="id"
        loading={transfers.isLoading}
        pagination={false}
        dataSource={transfers.data?.items ?? []}
        columns={[
          { title: t('inventory.field.number'), dataIndex: 'number' },
          {
            title: t('inventory.transfer.from'),
            render: (_, row) => refs.storeName(row.fromStoreId),
          },
          { title: t('inventory.transfer.to'), render: (_, row) => refs.storeName(row.toStoreId) },
          {
            title: t('inventory.field.status'),
            render: (_, row) => t(`inventory.transfer.status.${row.status}`),
          },
          {
            title: '',
            render: (_, row) => (canTransfer ? <Space>{buttons(row)}</Space> : null),
          },
        ]}
      />
    </div>
  );
}
