import {
  accountingDocTypes,
  accountingPermissions,
  type AccountingDocType,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { accountingApi, type Account, type Rule } from './api';
import { useErrorText } from './useErrorText';

interface Draft {
  id?: string;
  version?: number;
  sourceDocType: AccountingDocType;
  condition: string;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveFrom: string;
  active: boolean;
}

const blank: Draft = {
  sourceDocType: 'invoice',
  condition: '',
  debitAccountCode: '',
  creditAccountCode: '',
  effectiveFrom: '',
  active: true,
};

const conditionText = (condition: Record<string, string>) =>
  Object.entries(condition)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

/** One `name=value` per line; null when a line is not of that form. */
const parseCondition = (text: string): Record<string, string> | null => {
  const condition: Record<string, string> = {};
  for (const line of text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')) {
    const at = line.indexOf('=');
    if (at < 1) return null;
    condition[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return condition;
};

/** The mapping rules editor and the chart of accounts, read-only except switching an account (BR-1). */
export function RulesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(blank);
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const manage = can(accountingPermissions.rulesManage);

  const rules = useQuery({
    queryKey: ['accounting', 'rules'],
    queryFn: accountingApi.rules,
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ['accounting', 'accounts', showInactive],
    queryFn: () => accountingApi.accounts(showInactive),
    retry: false,
  });
  const accountOptions = (accounts.data ?? [])
    .filter((account) => account.active)
    .map((account) => ({ value: account.code, label: `${account.code} ${account.name}` }));
  const typeName = (value: string) =>
    t(`accounting.rules.docTypes.${value}`, { defaultValue: value });

  const failed = (cause: unknown) => {
    setNotice(null);
    setError(errorText(cause));
  };
  const save = useMutation({
    mutationFn: (body: Parameters<typeof accountingApi.saveRule>[0]) =>
      accountingApi.saveRule(body),
    onSuccess: async () => {
      setError(null);
      setNotice(t('accounting.rules.saved'));
      setDraft(blank);
      await queryClient.invalidateQueries({ queryKey: ['accounting', 'rules'] });
    },
    onError: failed,
  });
  const toggle = useMutation({
    mutationFn: (account: Account) => accountingApi.setAccountActive(account, !account.active),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['accounting', 'accounts'] });
    },
    onError: failed,
  });

  const submit = () => {
    const condition = parseCondition(draft.condition);
    if (condition === null) {
      setNotice(null);
      setError(t('accounting.rules.invalidCondition'));
      return;
    }
    save.mutate({
      ...(draft.id === undefined ? {} : { id: draft.id }),
      ...(draft.version === undefined ? {} : { version: draft.version }),
      sourceDocType: draft.sourceDocType,
      condition,
      debitAccountCode: draft.debitAccountCode,
      creditAccountCode: draft.creditAccountCode,
      effectiveFrom: draft.effectiveFrom,
      active: draft.active,
    });
  };
  const edit = (rule: Rule) =>
    setDraft({
      id: rule.id,
      version: rule.version,
      sourceDocType: rule.sourceDocType,
      condition: conditionText(rule.condition),
      debitAccountCode: rule.debitAccountCode,
      creditAccountCode: rule.creditAccountCode,
      effectiveFrom: rule.effectiveFrom,
      active: rule.active,
    });
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const complete =
    draft.debitAccountCode !== '' && draft.creditAccountCode !== '' && draft.effectiveFrom !== '';

  return (
    <div>
      <Typography.Title level={3}>{t('accounting.rules.title')}</Typography.Title>
      <Typography.Paragraph>{t('accounting.rules.intro')}</Typography.Paragraph>
      {error !== null && <Alert type="error" message={error} />}
      {notice !== null && <Alert type="success" message={notice} />}
      {rules.isError && <Alert type="error" message={errorText(rules.error)} />}

      <Table<Rule>
        size="small"
        rowKey="id"
        loading={rules.isLoading}
        pagination={false}
        dataSource={rules.data ?? []}
        locale={{ emptyText: t('accounting.rules.empty') }}
        columns={[
          {
            key: 'type',
            title: t('accounting.rules.docType'),
            render: (_, row) => typeName(row.sourceDocType),
          },
          {
            key: 'condition',
            title: t('accounting.rules.condition'),
            render: (_, row) => conditionText(row.condition).replaceAll('\n', ', '),
          },
          { key: 'debit', title: t('accounting.rules.debit'), dataIndex: 'debitAccountCode' },
          { key: 'credit', title: t('accounting.rules.credit'), dataIndex: 'creditAccountCode' },
          { key: 'from', title: t('accounting.rules.effectiveFrom'), dataIndex: 'effectiveFrom' },
          {
            key: 'active',
            title: t('accounting.rules.active'),
            render: (_, row) => (row.active ? t('common.yes') : t('common.no')),
          },
          {
            key: 'edit',
            title: '',
            render: (_, row) =>
              manage ? (
                <Button size="small" onClick={() => edit(row)}>
                  {t('accounting.rules.edit')}
                </Button>
              ) : null,
          },
        ]}
      />

      {manage && (
        <div style={{ margin: '16px 0' }}>
          <Typography.Title level={4}>{t('accounting.rules.add')}</Typography.Title>
          <Space wrap align="start">
            <Select
              aria-label={t('accounting.rules.docType')}
              style={{ width: 180 }}
              value={draft.sourceDocType}
              onChange={(value) => set({ sourceDocType: value })}
              options={accountingDocTypes.map((value) => ({ value, label: typeName(value) }))}
            />
            <Input.TextArea
              aria-label={t('accounting.rules.condition')}
              placeholder={t('accounting.rules.condition')}
              rows={2}
              style={{ width: 240 }}
              value={draft.condition}
              onChange={(event) => set({ condition: event.target.value })}
            />
            <Select
              aria-label={t('accounting.rules.debit')}
              showSearch
              placeholder={t('accounting.rules.debit')}
              optionFilterProp="label"
              style={{ width: 260 }}
              value={draft.debitAccountCode === '' ? undefined : draft.debitAccountCode}
              onChange={(value) => set({ debitAccountCode: value })}
              options={accountOptions}
            />
            <Select
              aria-label={t('accounting.rules.credit')}
              showSearch
              placeholder={t('accounting.rules.credit')}
              optionFilterProp="label"
              style={{ width: 260 }}
              value={draft.creditAccountCode === '' ? undefined : draft.creditAccountCode}
              onChange={(value) => set({ creditAccountCode: value })}
              options={accountOptions}
            />
            <Input
              aria-label={t('accounting.rules.effectiveFrom')}
              type="date"
              value={draft.effectiveFrom}
              onChange={(event) => set({ effectiveFrom: event.target.value })}
            />
            <Checkbox
              checked={draft.active}
              onChange={(event) => set({ active: event.target.checked })}
            >
              {t('accounting.rules.active')}
            </Checkbox>
            <Button type="primary" disabled={!complete} loading={save.isPending} onClick={submit}>
              {t('accounting.rules.save')}
            </Button>
          </Space>
        </div>
      )}

      <Typography.Title level={4} style={{ marginTop: 24 }}>
        {t('accounting.rules.chart')}
      </Typography.Title>
      <Typography.Paragraph>{t('accounting.rules.chartIntro')}</Typography.Paragraph>
      <Checkbox checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)}>
        {t('accounting.rules.showInactive')}
      </Checkbox>
      <Table<Account>
        size="small"
        rowKey="code"
        loading={accounts.isLoading}
        pagination={false}
        dataSource={accounts.data ?? []}
        columns={[
          { key: 'code', title: t('accounting.rules.code'), dataIndex: 'code' },
          { key: 'name', title: t('accounting.rules.name'), dataIndex: 'name' },
          {
            key: 'type',
            title: t('accounting.rules.accountType'),
            render: (_, row) => t(`accounting.rules.types.${row.type}`, { defaultValue: row.type }),
          },
          {
            key: 'active',
            title: t('accounting.rules.active'),
            render: (_, row) => (row.active ? t('common.yes') : t('common.no')),
          },
          {
            key: 'toggle',
            title: '',
            render: (_, row) =>
              manage ? (
                <Button size="small" loading={toggle.isPending} onClick={() => toggle.mutate(row)}>
                  {row.active ? t('accounting.rules.switchOff') : t('accounting.rules.switchOn')}
                </Button>
              ) : null,
          },
        ]}
      />
    </div>
  );
}
