import { formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { expensesApi, type Advance } from './api';
import { useErrorText } from './shared';

function SettleDialog({
  error,
  busy,
  onCancel,
  onConfirm,
}: {
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  return (
    <Modal
      open
      title={t('expenses.advances.settleTitle')}
      okText={t('expenses.advances.settleConfirm')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      onCancel={onCancel}
      onOk={() => onConfirm(note)}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {error !== null && <Alert type="error" message={error} />}
        <Input.TextArea
          aria-label={t('expenses.advances.settleNote')}
          placeholder={t('expenses.advances.settleNote')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Space>
    </Modal>
  );
}

/** Cash advances to custodians: the list, issuing one, and settling one by hand. */
export function AdvancesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const today = new Date().toISOString().slice(0, 10);
  const [custodianId, setCustodianId] = useState('');
  const [amount, setAmount] = useState('');
  const [issuedOn, setIssuedOn] = useState(today);
  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [settling, setSettling] = useState<Advance | null>(null);

  const advances = useQuery({ queryKey: ['expense-advances'], queryFn: expensesApi.advances });
  const custodians = useQuery({
    queryKey: ['expense-custodians'],
    queryFn: expensesApi.custodians,
  });
  const candidates = useQuery({
    queryKey: ['expense-candidates'],
    queryFn: expensesApi.candidates,
  });
  const nameOf = (id: string) => candidates.data?.find((c) => c.id === id)?.fullName ?? id;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['expense-advances'] });
    await queryClient.invalidateQueries({ queryKey: ['expense-custodians'] });
  };

  const issue = useMutation({
    mutationFn: () =>
      expensesApi.issueAdvance({
        custodianId,
        amount: amount.trim(),
        issuedOn,
        purpose: purpose.trim(),
      }),
    onSuccess: async () => {
      setError(null);
      setAmount('');
      setPurpose('');
      await refresh();
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const settle = useMutation({
    mutationFn: ({ advance, note }: { advance: Advance; note: string }) =>
      expensesApi.settleAdvance(advance.id, advance.version, note),
    onSuccess: async () => {
      setError(null);
      setSettling(null);
      await refresh();
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const submit = () => {
    if (custodianId === '' || !/^\d+(\.\d{1,2})?$/.test(amount.trim()) || purpose.trim() === '') {
      setError(t('expenses.advances.incomplete'));
      return;
    }
    setError(null);
    issue.mutate();
  };

  return (
    <div>
      <Typography.Title level={3}>{t('expenses.advances.title')}</Typography.Title>
      {error !== null && settling === null && (
        <Alert type="error" message={error} style={{ marginBottom: 12 }} />
      )}
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          aria-label={t('expenses.advances.custodian')}
          placeholder={t('expenses.advances.custodian')}
          style={{ width: 220 }}
          value={custodianId === '' ? undefined : custodianId}
          options={(custodians.data ?? []).map((c) => ({
            value: c.userId,
            label: nameOf(c.userId),
          }))}
          onChange={setCustodianId}
        />
        <Input
          aria-label={t('expenses.advances.amount')}
          placeholder={t('expenses.advances.amount')}
          inputMode="decimal"
          style={{ width: 140 }}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <Input
          type="date"
          aria-label={t('expenses.advances.issuedOn')}
          style={{ width: 160 }}
          value={issuedOn}
          onChange={(event) => setIssuedOn(event.target.value)}
        />
        <Input
          aria-label={t('expenses.advances.purpose')}
          placeholder={t('expenses.advances.purpose')}
          style={{ width: 260 }}
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
        />
        <Button type="primary" loading={issue.isPending} onClick={submit}>
          {t('expenses.advances.issue')}
        </Button>
      </Space>
      <Table<Advance>
        rowKey="id"
        size="small"
        scroll={{ x: 'max-content' }}
        loading={advances.isLoading}
        locale={{ emptyText: t('expenses.advances.empty') }}
        dataSource={advances.data?.items ?? []}
        columns={[
          { title: t('expenses.advances.number'), dataIndex: 'number' },
          {
            title: t('expenses.advances.custodian'),
            render: (_, advance) => nameOf(advance.custodianId),
          },
          {
            title: t('expenses.advances.amount'),
            align: 'right',
            render: (_, advance) => formatAmount(advance.amount),
          },
          {
            title: t('expenses.advances.issuedOn'),
            render: (_, advance) => formatDate(advance.issuedOn),
          },
          { title: t('expenses.advances.purpose'), dataIndex: 'purpose' },
          {
            title: t('expenses.advances.status'),
            render: (_, advance) => <Tag>{t(`expenses.advanceStatus.${advance.status}`)}</Tag>,
          },
          {
            title: '',
            render: (_, advance) =>
              advance.status === 'issued' ? (
                <Button size="small" onClick={() => setSettling(advance)}>
                  {t('expenses.advances.settle')}
                </Button>
              ) : null,
          },
        ]}
      />
      {settling !== null && (
        <SettleDialog
          error={error}
          busy={settle.isPending}
          onCancel={() => {
            setSettling(null);
            setError(null);
          }}
          onConfirm={(note) => settle.mutate({ advance: settling, note })}
        />
      )}
    </div>
  );
}
