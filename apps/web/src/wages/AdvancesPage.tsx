import { formatAmount, formatDate, wagesPermissions as perm } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { karachiToday } from '../attendance/form';
import { wagesApi, type Advance } from './api';
import { isAmount, useErrorText } from './form';

const selectStyle = { minWidth: 160, padding: '4px 6px' } as const;

/** Simple advances: who owes how much, and the form that issues a new one (BR-6). */
export function WageAdvancesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [workerId, setWorkerId] = useState('');
  const [amount, setAmount] = useState('');
  const [recovery, setRecovery] = useState('');
  const [issuedOn, setIssuedOn] = useState(karachiToday());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['wage-advances'], queryFn: () => wagesApi.advances() });
  const workers = useQuery({
    queryKey: ['wage-workers'],
    queryFn: wagesApi.workers,
    enabled: can(perm.advanceManage),
  });
  const issue = useMutation({
    mutationFn: () =>
      wagesApi.issueAdvance({
        workerId,
        amount: amount.trim(),
        monthlyRecovery: recovery.trim(),
        issuedOn,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: async () => {
      setError(null);
      setAmount('');
      setRecovery('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['wage-advances'] });
    },
    onError: (cause) => setError(errorText(cause)),
  });
  const valid =
    workerId !== '' &&
    isAmount(amount) &&
    isAmount(recovery) &&
    Number(recovery) <= Number(amount) &&
    /^\d{4}-\d{2}-\d{2}$/.test(issuedOn);

  return (
    <div>
      <Typography.Title level={3}>{t('wages.advances.title')}</Typography.Title>
      {can(perm.advanceManage) && (
        <Space style={{ marginBottom: 12 }} wrap>
          <select
            aria-label={t('wages.advances.worker')}
            style={selectStyle}
            value={workerId}
            onChange={(event) => setWorkerId(event.target.value)}
          >
            <option value="">{t('wages.advances.pickWorker')}</option>
            {(workers.data?.items ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} {w.fullName}
              </option>
            ))}
          </select>
          <Input
            aria-label={t('wages.advances.amount')}
            placeholder={t('wages.advances.amount')}
            style={{ width: 130 }}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <Input
            aria-label={t('wages.advances.monthlyRecovery')}
            placeholder={t('wages.advances.monthlyRecovery')}
            style={{ width: 160 }}
            value={recovery}
            onChange={(event) => setRecovery(event.target.value)}
          />
          <Input
            type="date"
            aria-label={t('wages.advances.issuedOn')}
            value={issuedOn}
            onChange={(event) => setIssuedOn(event.target.value)}
          />
          <Input
            aria-label={t('wages.advances.note')}
            placeholder={t('wages.advances.note')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button
            type="primary"
            disabled={!valid}
            loading={issue.isPending}
            onClick={() => issue.mutate()}
          >
            {t('wages.advances.issue')}
          </Button>
        </Space>
      )}
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<Advance>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={list.data?.items ?? []}
        locale={{ emptyText: t('wages.advances.empty') }}
        columns={[
          {
            title: t('wages.advances.worker'),
            render: (_, a) => `${a.workerCode ?? ''} ${a.workerName ?? ''}`.trim(),
          },
          { title: t('wages.advances.issuedOn'), render: (_, a) => formatDate(a.issuedOn) },
          { title: t('wages.advances.amount'), render: (_, a) => formatAmount(a.amount) },
          {
            title: t('wages.advances.monthlyRecovery'),
            render: (_, a) => formatAmount(a.monthlyRecovery),
          },
          { title: t('wages.advances.balance'), render: (_, a) => formatAmount(a.balance) },
          {
            title: t('wages.advances.status'),
            render: (_, a) => <Tag>{t(`wages.advanceStatus.${a.status}`)}</Tag>,
          },
        ]}
      />
    </div>
  );
}
