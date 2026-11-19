import { cashbookPermissions as perm, formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { cashbookApi, type Reconciliation } from './api';
import { isSignedAmount } from './form';

/** Bank statements being reconciled, newest first, and the form that starts a new one. */
export function ReconciliationsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [closing, setClosing] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['cashbook', 'reconciliations'],
    queryFn: cashbookApi.reconciliations,
  });
  const accounts = useQuery({
    queryKey: ['cashbook', 'accounts', false],
    queryFn: () => cashbookApi.accounts(false),
  });
  const create = useMutation({
    mutationFn: () =>
      cashbookApi.createReconciliation({
        accountId,
        statementFrom: from,
        statementTo: to,
        statementClosingBalance: closing.trim(),
      }),
    onSuccess: (row) => void navigate(`/cashbook/reconciliations/${row.id}`),
  });
  const accountName = (id: string) => {
    const account = accounts.data?.find((a) => a.id === id);
    return account === undefined ? id : `${account.code} ${account.name}`;
  };
  const submit = () => {
    if (accountId === '' || from === '' || to === '') {
      setProblem(t('cashbook.recon.incomplete'));
      return;
    }
    if (!isSignedAmount(closing)) {
      setProblem(t('cashbook.recon.closingInvalid'));
      return;
    }
    setProblem(null);
    create.mutate();
  };
  return (
    <div>
      <Typography.Title level={3}>{t('cashbook.recon.title')}</Typography.Title>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<Reconciliation>
        rowKey="id"
        size="small"
        pagination={false}
        style={{ marginBottom: 16 }}
        locale={{ emptyText: t('cashbook.recon.empty') }}
        dataSource={list.data ?? []}
        columns={[
          {
            title: t('cashbook.recon.statement'),
            render: (_, row) => (
              <Link to={`/cashbook/reconciliations/${row.id}`}>
                {`${formatDate(row.statementFrom)} – ${formatDate(row.statementTo)}`}
              </Link>
            ),
          },
          { title: t('cashbook.txn.account'), render: (_, row) => accountName(row.accountId) },
          {
            title: t('cashbook.recon.closing'),
            align: 'right',
            render: (_, row) => formatAmount(row.statementClosingBalance),
          },
          {
            title: t('cashbook.recon.status'),
            render: (_, row) => <Tag>{t(`cashbook.recon.state.${row.status}`)}</Tag>,
          },
        ]}
      />
      {can(perm.reconcile) && (
        <div>
          <Typography.Title level={4}>{t('cashbook.recon.new')}</Typography.Title>
          {problem !== null && (
            <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />
          )}
          <Space wrap align="end">
            <Select
              aria-label={t('cashbook.txn.account')}
              placeholder={t('cashbook.txn.account')}
              style={{ width: 260 }}
              value={accountId === '' ? undefined : accountId}
              onChange={setAccountId}
              options={(accounts.data ?? []).map((a) => ({
                value: a.id,
                label: `${a.code} ${a.name}`,
              }))}
            />
            <Input
              aria-label={t('cashbook.recon.from')}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <Input
              aria-label={t('cashbook.recon.to')}
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <Input
              aria-label={t('cashbook.recon.closing')}
              placeholder={t('cashbook.recon.closing')}
              value={closing}
              onChange={(e) => setClosing(e.target.value)}
            />
            <Button type="primary" loading={create.isPending} onClick={submit}>
              {t('cashbook.recon.create')}
            </Button>
          </Space>
        </div>
      )}
    </div>
  );
}
