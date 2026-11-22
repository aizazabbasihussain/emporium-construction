import { accountingDocTypes, formatAmount, type AccountingDocType } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { accountingApi, type BackfillPlan, type Untagged } from './api';
import { useErrorText } from './useErrorText';

const keyOf = (row: Untagged) => `${row.sourceDocType}|${row.sourceDocId}|${row.lineRef}`;

/** The untagged queue: lines without an account code, bulk tagging and the backfill (BR-2, BR-9, AC-2). */
export function UntaggedPage() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [docType, setDocType] = useState<AccountingDocType | ''>('');
  const [selected, setSelected] = useState<string[]>([]);
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<BackfillPlan | null>(null);

  const queue = useQuery({
    queryKey: ['accounting', 'untagged', from, to, docType],
    queryFn: () =>
      accountingApi.untagged({
        from: from === '' ? undefined : from,
        to: to === '' ? undefined : to,
        docType: docType === '' ? undefined : docType,
      }),
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ['accounting', 'accounts', false],
    queryFn: () => accountingApi.accounts(false),
    retry: false,
  });
  const rows = queue.data?.items ?? [];
  const typeName = (value: string) =>
    t(`accounting.rules.docTypes.${value}`, { defaultValue: value });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['accounting', 'untagged'] });
  const failed = (cause: unknown) => {
    setNotice(null);
    setError(errorText(cause));
  };

  const tag = useMutation({
    mutationFn: () =>
      accountingApi.tag(
        rows
          .filter((row) => selected.includes(keyOf(row)))
          .map((row) => ({
            docType: row.sourceDocType,
            docId: row.sourceDocId,
            lineRef: row.lineRef,
          })),
        account as string,
      ),
    onSuccess: async () => {
      setError(null);
      setNotice(t('accounting.untagged.tagged', { count: selected.length }));
      setSelected([]);
      await refresh();
    },
    onError: failed,
  });
  const backfill = useMutation({
    mutationFn: (mode: 'dry-run' | 'commit') => accountingApi.backfill(mode, { from, to }),
    onSuccess: async (result) => {
      setError(null);
      setPlan(result);
      if (!result.dryRun) await refresh();
    },
    onError: failed,
  });

  return (
    <div>
      <Typography.Title level={3}>{t('accounting.untagged.title')}</Typography.Title>
      <Typography.Paragraph>{t('accounting.untagged.intro')}</Typography.Paragraph>
      {error !== null && <Alert type="error" message={error} />}
      {notice !== null && <Alert type="success" message={notice} />}
      {queue.isError && <Alert type="error" message={errorText(queue.error)} />}

      <Space wrap align="end" style={{ margin: '12px 0' }}>
        <label>
          <div>{t('accounting.untagged.from')}</div>
          <Input
            aria-label={t('accounting.untagged.from')}
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          <div>{t('accounting.untagged.to')}</div>
          <Input
            aria-label={t('accounting.untagged.to')}
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <label>
          <div>{t('accounting.untagged.type')}</div>
          <Select
            aria-label={t('accounting.untagged.type')}
            style={{ width: 200 }}
            value={docType}
            onChange={(value) => {
              setDocType(value);
              setSelected([]);
            }}
            options={[
              { value: '', label: t('accounting.untagged.allTypes') },
              ...accountingDocTypes.map((value) => ({ value, label: typeName(value) })),
            ]}
          />
        </label>
      </Space>
      {queue.data !== undefined && Object.keys(queue.data.byType).length > 0 && (
        <Typography.Paragraph>
          {t('accounting.untagged.counts')}:{' '}
          {Object.entries(queue.data.byType)
            .map(([type, count]) => `${typeName(type)} ${count}`)
            .join('; ')}
        </Typography.Paragraph>
      )}

      <Space wrap align="end" style={{ margin: '8px 0' }}>
        <Select
          aria-label={t('accounting.untagged.account')}
          showSearch
          placeholder={t('accounting.untagged.account')}
          style={{ width: 320 }}
          optionFilterProp="label"
          value={account}
          onChange={setAccount}
          options={(accounts.data ?? []).map((a) => ({
            value: a.code,
            label: `${a.code} ${a.name}`,
          }))}
        />
        <Button
          type="primary"
          disabled={selected.length === 0 || account === undefined}
          loading={tag.isPending}
          onClick={() => tag.mutate()}
        >
          {t('accounting.untagged.tag')}
        </Button>
        <Typography.Text type="secondary">
          {t('accounting.untagged.selected', { count: selected.length })}
        </Typography.Text>
      </Space>

      <Table<Untagged>
        size="small"
        rowKey={keyOf}
        loading={queue.isLoading}
        pagination={false}
        dataSource={rows}
        locale={{ emptyText: t('accounting.untagged.empty') }}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys as string[]),
        }}
        columns={[
          { key: 'date', title: t('accounting.untagged.date'), dataIndex: 'date' },
          {
            key: 'type',
            title: t('accounting.untagged.type'),
            render: (_, row) => typeName(row.sourceDocType),
          },
          { key: 'number', title: t('accounting.untagged.number'), dataIndex: 'number' },
          { key: 'party', title: t('accounting.untagged.party'), dataIndex: 'party' },
          {
            key: 'amount',
            title: t('accounting.untagged.amount'),
            align: 'right',
            render: (_, row) => formatAmount(row.amount),
          },
          {
            key: 'suggested',
            title: t('accounting.untagged.suggested'),
            render: (_, row) => row.suggestedAccountCode ?? t('accounting.untagged.none'),
          },
        ]}
      />

      <Typography.Title level={4} style={{ marginTop: 24 }}>
        {t('accounting.untagged.backfill')}
      </Typography.Title>
      <Space>
        <Button loading={backfill.isPending} onClick={() => backfill.mutate('dry-run')}>
          {t('accounting.untagged.dryRun')}
        </Button>
        <Button
          danger
          disabled={plan === null || !plan.dryRun}
          loading={backfill.isPending}
          onClick={() => backfill.mutate('commit')}
        >
          {t('accounting.untagged.commit')}
        </Button>
      </Space>
      {plan !== null && (
        <Typography.Paragraph style={{ marginTop: 8 }}>
          {plan.dryRun
            ? t('accounting.untagged.dryRunResult', { ...plan })
            : t('accounting.untagged.commitResult', { ...plan })}
          {plan.sample.length > 0 && (
            <>
              {' '}
              {t('accounting.untagged.sample')}:{' '}
              {plan.sample.map((s) => `${s.sourceDocId} → ${s.accountCode}`).join('; ')}
            </>
          )}
        </Typography.Paragraph>
      )}
    </div>
  );
}
