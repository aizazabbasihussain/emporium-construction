import { inventoryPermissions } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Select, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { inventoryApi, type Count } from './api';
import { useInventoryReferences } from './references';
import { today, useErrorText } from './shared';
import { emptySheetLine, SheetLines, sheetProblem, type SheetLine } from './SheetLines';

/** Count sheets: counted quantities next to the books; adjustments post once the owner approves (BR-8). */
export function CountsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const refs = useInventoryReferences();
  const errorText = useErrorText();
  const canCount = can(inventoryPermissions.stockCount);
  const [storeId, setStoreId] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<SheetLine[]>([emptySheetLine()]);
  const [error, setError] = useState<string | null>(null);

  const counts = useQuery({ queryKey: ['inventory-counts'], queryFn: inventoryApi.counts });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['inventory-counts'] });
  const create = useMutation({
    mutationFn: inventoryApi.createCount,
    onSuccess: () => {
      setLines([emptySheetLine()]);
      setError(null);
      refresh();
    },
    onError: (cause) => setError(errorText(cause)),
  });
  const act = useMutation({
    mutationFn: (input: { id: string; action: 'submit' | 'cancel'; version: number }) =>
      inventoryApi.countAction(input.id, input.action, input.version),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const submit = () => {
    const problem = sheetProblem(lines);
    if (storeId === undefined) {
      setError(t('inventory.count.store'));
      return;
    }
    if (problem !== null) {
      setError(t(problem));
      return;
    }
    create.mutate({
      storeId,
      countedOn: today(),
      lines: lines.map((line) => ({
        itemId: line.itemId as string,
        countedQty: line.quantity.trim(),
      })),
    });
  };

  return (
    <div>
      <Typography.Title level={3}>{t('inventory.count.title')}</Typography.Title>
      {error !== null && (
        <Alert style={{ marginBottom: 12 }} type="error" showIcon message={error} />
      )}
      {canCount && (
        <div style={{ maxWidth: 640, marginBottom: 24 }}>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 280, marginBottom: 12 }}
            aria-label={t('inventory.field.store')}
            placeholder={t('inventory.field.store')}
            value={storeId}
            onChange={(value: string) => setStoreId(value)}
            options={refs.storeOptions}
          />
          <SheetLines
            lines={lines}
            itemOptions={refs.itemOptions}
            quantityLabel={t('inventory.count.counted')}
            onChange={setLines}
          />
          <Button
            type="primary"
            style={{ marginTop: 12 }}
            loading={create.isPending}
            onClick={submit}
          >
            {t('inventory.count.create')}
          </Button>
        </div>
      )}
      <Table<Count>
        rowKey="id"
        loading={counts.isLoading}
        pagination={false}
        dataSource={counts.data?.items ?? []}
        expandable={{
          expandedRowRender: (row) => (
            <ul>
              {row.lines.map((line) => (
                <li key={line.id}>
                  {refs.itemName(line.itemId)}: {line.systemQty} → {line.countedQty}
                </li>
              ))}
            </ul>
          ),
        }}
        columns={[
          { title: t('inventory.field.number'), dataIndex: 'number' },
          { title: t('inventory.field.store'), render: (_, row) => refs.storeName(row.storeId) },
          { title: t('inventory.field.date'), dataIndex: 'countedOn' },
          {
            title: t('inventory.field.status'),
            render: (_, row) => t(`inventory.count.status.${row.status}`),
          },
          {
            title: '',
            render: (_, row) =>
              canCount && (row.status === 'draft' || row.status === 'counted') ? (
                <>
                  {row.status === 'draft' && (
                    <Button
                      size="small"
                      onClick={() =>
                        act.mutate({ id: row.id, action: 'submit', version: row.version })
                      }
                    >
                      {t('inventory.count.submit')}
                    </Button>
                  )}{' '}
                  <Button
                    size="small"
                    onClick={() =>
                      act.mutate({ id: row.id, action: 'cancel', version: row.version })
                    }
                  >
                    {t('inventory.count.cancel')}
                  </Button>
                </>
              ) : null,
          },
        ]}
      />
    </div>
  );
}
