import { cashbookPermissions as perm, formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { cashbookApi, type Pending } from './api';

/** Advances announced by expenses that wait for a cash account (BR-6). */
export function PendingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const list = useQuery({ queryKey: ['cashbook', 'pending'], queryFn: cashbookApi.pending });
  const accounts = useQuery({
    queryKey: ['cashbook', 'accounts', false],
    queryFn: () => cashbookApi.accounts(false),
  });
  const record = useMutation({
    mutationFn: (row: Pending) => cashbookApi.recordPending(row.id, chosen[row.id] as string),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['cashbook'] }),
  });
  return (
    <div>
      <Typography.Title level={3}>{t('cashbook.pending.title')}</Typography.Title>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<Pending>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('cashbook.pending.empty') }}
        dataSource={list.data ?? []}
        columns={[
          { title: t('cashbook.txn.date'), render: (_, row) => formatDate(row.txnDate) },
          { title: t('cashbook.txn.description'), render: (_, row) => row.description ?? '' },
          {
            title: t('cashbook.entry.amount'),
            align: 'right',
            render: (_, row) => formatAmount(row.amount),
          },
          { title: t('cashbook.pending.note'), render: (_, row) => row.note ?? '' },
          {
            title: '',
            render: (_, row) =>
              can(perm.txnCreate) && (
                <Space>
                  <Select
                    aria-label={`${t('cashbook.txn.account')} ${row.description ?? row.id}`}
                    style={{ width: 220 }}
                    value={chosen[row.id]}
                    onChange={(value) => setChosen({ ...chosen, [row.id]: value })}
                    options={(accounts.data ?? []).map((a) => ({
                      value: a.id,
                      label: `${a.code} ${a.name}`,
                    }))}
                  />
                  <Button
                    disabled={chosen[row.id] === undefined}
                    loading={record.isPending}
                    onClick={() => record.mutate(row)}
                  >
                    {t('cashbook.pending.record')}
                  </Button>
                </Space>
              ),
          },
        ]}
      />
    </div>
  );
}
