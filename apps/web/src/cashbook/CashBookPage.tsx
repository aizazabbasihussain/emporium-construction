import { cashbookPermissions as perm, formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { cashbookApi, type Txn } from './api';

/**
 * The cash book: every movement with the balance after it (BR-1). With `needsTag` it is the list of
 * untagged transactions instead (BR-7), where the accountant sets the account code.
 */
export function CashBookPage({ needsTag = false }: { needsTag?: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reversing, setReversing] = useState<Txn | null>(null);
  const [reason, setReason] = useState('');
  const [tags, setTags] = useState<Record<string, string>>({});

  const accounts = useQuery({
    queryKey: ['cashbook', 'accounts', true],
    queryFn: () => cashbookApi.accounts(true),
  });
  const list = useQuery({
    queryKey: ['cashbook', 'transactions', accountId, from, to, needsTag],
    queryFn: () =>
      cashbookApi.transactions({
        ...(accountId === '' ? {} : { accountId }),
        ...(from === '' ? {} : { from }),
        ...(to === '' ? {} : { to }),
        needsTag,
      }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['cashbook'] });
  const reverse = useMutation({
    mutationFn: () => cashbookApi.reverse((reversing as Txn).id, reason.trim()),
    onSuccess: () => {
      setReversing(null);
      setReason('');
      void refresh();
    },
  });
  const tag = useMutation({
    mutationFn: (txn: Txn) => cashbookApi.setTag(txn.id, tags[txn.id]?.trim() || null),
    onSuccess: () => void refresh(),
  });

  const accountName = (id: string) => {
    const account = accounts.data?.find((a) => a.id === id);
    return account === undefined ? id : `${account.code} ${account.name}`;
  };
  const canReverse = (txn: Txn) =>
    can(perm.txnReverse) && !txn.reversed && txn.reversesId === null && txn.reconciledIn === null;

  return (
    <div>
      <Typography.Title level={3}>
        {needsTag ? t('cashbook.needsTag.title') : t('cashbook.book.title')}
      </Typography.Title>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          aria-label={t('cashbook.txn.account')}
          style={{ width: 260 }}
          value={accountId}
          onChange={setAccountId}
          options={[
            { value: '', label: t('cashbook.book.allAccounts') },
            ...(accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })),
          ]}
        />
        <Input
          aria-label={t('cashbook.book.from')}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          aria-label={t('cashbook.book.to')}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        {can(perm.txnCreate) && !needsTag && (
          <>
            <Link to="/cashbook/receipts/new">{t('cashbook.book.newReceipt')}</Link>
            <Link to="/cashbook/payments/new">{t('cashbook.book.newPayment')}</Link>
            <Link to="/cashbook/transfers/new">{t('cashbook.book.newTransfer')}</Link>
          </>
        )}
      </Space>
      <Table<Txn>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('cashbook.book.empty') }}
        dataSource={list.data?.items ?? []}
        columns={[
          { title: t('cashbook.txn.date'), render: (_, row) => formatDate(row.txnDate) },
          { title: t('cashbook.txn.number'), dataIndex: 'number' },
          { title: t('cashbook.txn.account'), render: (_, row) => accountName(row.accountId) },
          {
            title: t('cashbook.txn.description'),
            render: (_, row) => (
              <span>
                {t(`cashbook.type.${row.txnType}`)}
                {row.description === null ? '' : ` · ${row.description}`}
                {row.reversed && (
                  <Tag style={{ marginInlineStart: 6 }}>{t('cashbook.txn.reversed')}</Tag>
                )}
                {row.reversesId !== null && (
                  <Tag style={{ marginInlineStart: 6 }}>{t('cashbook.txn.reversal')}</Tag>
                )}
              </span>
            ),
          },
          {
            title: t('cashbook.txn.in'),
            align: 'right',
            render: (_, row) => (row.direction === 'in' ? formatAmount(row.amount) : ''),
          },
          {
            title: t('cashbook.txn.out'),
            align: 'right',
            render: (_, row) => (row.direction === 'out' ? formatAmount(row.amount) : ''),
          },
          {
            title: t('cashbook.txn.balance'),
            align: 'right',
            render: (_, row) =>
              row.runningBalance === undefined ? '' : formatAmount(row.runningBalance),
          },
          {
            title: t('cashbook.txn.tag'),
            render: (_, row) =>
              needsTag && can(perm.txnCreate) ? (
                <Space.Compact>
                  <Input
                    aria-label={`${t('cashbook.txn.tag')} ${row.number}`}
                    value={tags[row.id] ?? ''}
                    onChange={(e) => setTags({ ...tags, [row.id]: e.target.value })}
                    style={{ width: 120 }}
                  />
                  <Button onClick={() => tag.mutate(row)}>{t('cashbook.txn.saveTag')}</Button>
                </Space.Compact>
              ) : (
                (row.accountTag ?? '')
              ),
          },
          {
            title: '',
            render: (_, row) =>
              !needsTag &&
              canReverse(row) && (
                <Button size="small" onClick={() => setReversing(row)}>
                  {t('cashbook.txn.reverse')}
                </Button>
              ),
          },
        ]}
      />
      <Modal
        open={reversing !== null}
        title={t('cashbook.reverse.title', { number: reversing?.number })}
        okText={t('cashbook.txn.reverse')}
        okButtonProps={{ disabled: reason.trim() === '', loading: reverse.isPending }}
        onOk={() => reverse.mutate()}
        onCancel={() => setReversing(null)}
      >
        <Input.TextArea
          aria-label={t('cashbook.reverse.reason')}
          placeholder={t('cashbook.reverse.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Modal>
    </div>
  );
}
