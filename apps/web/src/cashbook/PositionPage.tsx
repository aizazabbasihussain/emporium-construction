import { formatAmount, formatDate } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Descriptions, Input, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cashbookApi, type Position } from './api';

const today = () => new Date().toISOString().slice(0, 10);

/** The daily cash position (BR-9): balances per account, totals and the movement of the day. */
export function PositionPage() {
  const { t } = useTranslation();
  const [date, setDate] = useState(today());
  const position = useQuery({
    queryKey: ['cashbook', 'position', date],
    queryFn: () => cashbookApi.position(date),
    enabled: date !== '',
  });
  const data = position.data;
  return (
    <div>
      <Typography.Title level={3}>{t('cashbook.position.title')}</Typography.Title>
      {position.isError && <Alert type="error" message={t('common.loadError')} />}
      <Input
        aria-label={t('cashbook.position.date')}
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        style={{ width: 200, marginBottom: 12 }}
      />
      {data !== undefined && (
        <>
          <Descriptions bordered size="small" column={2} style={{ marginBottom: 12 }}>
            <Descriptions.Item label={t('cashbook.position.cash')}>
              {formatAmount(data.totalCash)}
            </Descriptions.Item>
            <Descriptions.Item label={t('cashbook.position.bank')}>
              {formatAmount(data.totalBank)}
            </Descriptions.Item>
            <Descriptions.Item label={t('cashbook.position.total')}>
              {formatAmount(data.total)}
            </Descriptions.Item>
            <Descriptions.Item label={t('cashbook.position.day', { date: formatDate(data.date) })}>
              {`+${formatAmount(data.movementIn)} / -${formatAmount(data.movementOut)}`}
            </Descriptions.Item>
          </Descriptions>
          <Table<Position['accounts'][number]>
            rowKey="accountId"
            size="small"
            pagination={false}
            locale={{ emptyText: t('cashbook.accounts.empty') }}
            dataSource={data.accounts}
            columns={[
              { title: t('cashbook.account.code'), dataIndex: 'code' },
              { title: t('cashbook.account.name'), dataIndex: 'name' },
              {
                title: t('cashbook.account.kind'),
                render: (_, row) => t(`cashbook.kind.${row.kind}`),
              },
              {
                title: t('cashbook.txn.in'),
                align: 'right',
                render: (_, row) => formatAmount(row.movementIn),
              },
              {
                title: t('cashbook.txn.out'),
                align: 'right',
                render: (_, row) => formatAmount(row.movementOut),
              },
              {
                title: t('cashbook.account.balance'),
                align: 'right',
                render: (_, row) => formatAmount(row.balance),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
