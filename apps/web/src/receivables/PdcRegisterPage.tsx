import {
  formatAmount,
  formatDate,
  pdcStatuses,
  receivablesPermissions as perm,
  type PdcStatus,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { cashbookApi } from '../cashbook/api';
import { receivablesApi, type Pdc } from './api';

type Action = 'deposit' | 'bounce' | 'replace';

/** The cheque register (BR-6, BR-7): cheques by status, the next seven days and the value in hand. */
export function PdcRegisterPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PdcStatus | undefined>(undefined);
  const [acting, setActing] = useState<{ action: Action; pdc: Pdc } | null>(null);
  const [accountId, setAccountId] = useState('');
  const [reason, setReason] = useState('');
  const [chequeNumber, setChequeNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const register = useQuery({
    queryKey: ['receivables', 'pdcs', status],
    queryFn: () => receivablesApi.pdcs(status),
  });
  const accounts = useQuery({
    queryKey: ['cashbook', 'accounts', false],
    queryFn: () => cashbookApi.accounts(false),
  });
  const done = () => {
    setActing(null);
    setReason('');
    setAccountId('');
    setProblem(null);
    void queryClient.invalidateQueries({ queryKey: ['receivables'] });
  };
  const fail = (error: unknown) =>
    setProblem(
      error instanceof ApiError
        ? t(`receivables.errors.${error.code}`, { defaultValue: error.message })
        : t('common.loadError'),
    );
  const simple = useMutation({
    mutationFn: ({ action, pdc }: { action: 'clear' | 'return'; pdc: Pdc }) =>
      action === 'clear' ? receivablesApi.clear(pdc) : receivablesApi.giveBack(pdc),
    onSuccess: done,
    onError: fail,
  });
  const confirm = useMutation({
    mutationFn: () => {
      const { action, pdc } = acting as { action: Action; pdc: Pdc };
      if (action === 'deposit') return receivablesApi.deposit(pdc, accountId, reason.trim());
      if (action === 'bounce') return receivablesApi.bounce(pdc, reason.trim());
      return receivablesApi.replace(pdc, {
        chequeNumber: chequeNumber.trim(),
        bankName: bankName.trim(),
        chequeDate,
      });
    },
    onSuccess: done,
    onError: fail,
  });

  const manage = can(perm.pdcManage);
  const data = register.data;
  return (
    <div>
      <Typography.Title level={3}>{t('receivables.pdc.title')}</Typography.Title>
      {register.isError && <Alert type="error" message={t('common.loadError')} />}
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      {data !== undefined && (
        <Space direction="vertical" style={{ marginBottom: 12 }}>
          <span>
            {t('receivables.pdc.inHand')}: <strong>{formatAmount(data.totalInHand)}</strong>
          </span>
          <span>
            {t('receivables.pdc.upcoming')}:{' '}
            {data.upcoming.map((p) => (
              <Tag key={p.id}>{`${p.chequeNumber} ${formatDate(p.chequeDate)}`}</Tag>
            ))}
          </span>
        </Space>
      )}
      <Select
        aria-label={t('receivables.pdc.status')}
        allowClear
        placeholder={t('receivables.pdc.all')}
        value={status}
        onChange={(value) => setStatus(value)}
        options={pdcStatuses.map((value) => ({ value, label: t(`receivables.status.${value}`) }))}
        style={{ width: 200, marginBottom: 12 }}
      />
      <Table<Pdc>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('receivables.pdc.none') }}
        dataSource={data?.items ?? []}
        columns={[
          { title: t('receivables.pdc.cheque'), render: (_, row) => row.chequeNumber },
          { title: t('receivables.pdc.bank'), render: (_, row) => row.bankName },
          {
            title: t('receivables.pdc.chequeDate'),
            render: (_, row) => formatDate(row.chequeDate),
          },
          {
            title: t('receivables.common.amount'),
            align: 'right',
            render: (_, row) => formatAmount(row.amount),
          },
          {
            title: t('receivables.pdc.status'),
            render: (_, row) => t(`receivables.status.${row.status}`),
          },
          {
            title: '',
            render: (_, row) =>
              manage && (
                <Space>
                  {row.status === 'received' && (
                    <Button onClick={() => setActing({ action: 'deposit', pdc: row })}>
                      {t('receivables.pdc.deposit')}
                    </Button>
                  )}
                  {row.status === 'deposited' && (
                    <Button onClick={() => simple.mutate({ action: 'clear', pdc: row })}>
                      {t('receivables.pdc.clear')}
                    </Button>
                  )}
                  {(row.status === 'deposited' || row.status === 'cleared') && (
                    <Button danger onClick={() => setActing({ action: 'bounce', pdc: row })}>
                      {t('receivables.pdc.bounce')}
                    </Button>
                  )}
                  {(row.status === 'received' || row.status === 'bounced') && (
                    <>
                      <Button onClick={() => simple.mutate({ action: 'return', pdc: row })}>
                        {t('receivables.pdc.giveBack')}
                      </Button>
                      <Button onClick={() => setActing({ action: 'replace', pdc: row })}>
                        {t('receivables.pdc.replace')}
                      </Button>
                    </>
                  )}
                </Space>
              ),
          },
        ]}
      />
      <Modal
        open={acting !== null}
        title={acting === null ? '' : t(`receivables.pdc.${acting.action}`)}
        okText={t('receivables.pdc.confirm')}
        cancelText={t('receivables.common.cancel')}
        confirmLoading={confirm.isPending}
        onOk={() => confirm.mutate()}
        onCancel={() => setActing(null)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {acting?.action === 'deposit' && (
            <>
              <Select
                aria-label={t('receivables.pdc.depositTo')}
                placeholder={t('receivables.pdc.depositTo')}
                value={accountId === '' ? undefined : accountId}
                onChange={setAccountId}
                options={(accounts.data ?? []).map((a) => ({
                  value: a.id,
                  label: `${a.code} ${a.name}`,
                }))}
                style={{ width: '100%' }}
              />
              <Input
                aria-label={t('receivables.pdc.overrideReason')}
                placeholder={t('receivables.pdc.overrideReason')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </>
          )}
          {acting?.action === 'bounce' && (
            <Input
              aria-label={t('receivables.pdc.bounceReason')}
              placeholder={t('receivables.pdc.bounceReason')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
          {acting?.action === 'replace' && (
            <>
              <Input
                aria-label={t('receivables.receipt.chequeNumber')}
                placeholder={t('receivables.receipt.chequeNumber')}
                value={chequeNumber}
                onChange={(e) => setChequeNumber(e.target.value)}
              />
              <Input
                aria-label={t('receivables.receipt.bank')}
                placeholder={t('receivables.receipt.bank')}
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
              />
              <Input
                aria-label={t('receivables.receipt.chequeDate')}
                type="date"
                value={chequeDate}
                onChange={(e) => setChequeDate(e.target.value)}
              />
            </>
          )}
        </Space>
      </Modal>
    </div>
  );
}
