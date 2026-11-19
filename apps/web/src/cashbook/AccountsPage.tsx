import {
  cashAccountKinds,
  cashbookPermissions as perm,
  formatAmount,
  formatDate,
} from '@emporium/shared';
import type { CashAccountKind } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { cashbookApi, type Account } from './api';
import { isSignedAmount, optional } from './form';

const today = () => new Date().toISOString().slice(0, 10);

/** Cash, bank, petty cash and wallet accounts with their balances (spec P2-03 section 5). */
export function AccountsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CashAccountKind>('cash');
  const [opening, setOpening] = useState('0');
  const [openingDate, setOpeningDate] = useState(today());
  const [bankName, setBankName] = useState('');
  const [masked, setMasked] = useState('');
  const [tag, setTag] = useState('');
  const [overdraft, setOverdraft] = useState(false);

  const list = useQuery({
    queryKey: ['cashbook', 'accounts', showInactive],
    queryFn: () => cashbookApi.accounts(showInactive),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['cashbook'] });
  const create = useMutation({
    mutationFn: () =>
      cashbookApi.createAccount({
        code: code.trim(),
        name: name.trim(),
        kind,
        openingBalance: opening.trim(),
        openingDate,
        ...(optional(bankName) === undefined ? {} : { bankName: bankName.trim() }),
        ...(optional(masked) === undefined ? {} : { accountNumberMasked: masked.trim() }),
        ...(optional(tag) === undefined ? {} : { accountCodeTag: tag.trim() }),
        allowOverdraft: overdraft,
      }),
    onSuccess: () => {
      setCode('');
      setName('');
      setOpening('0');
      void refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (account: Account) => cashbookApi.setActive(account, !account.active),
    onSuccess: () => void refresh(),
  });

  const submit = () => {
    if (code.trim() === '' || name.trim() === '' || openingDate === '') {
      setProblem(t('cashbook.accounts.incomplete'));
      return;
    }
    if (!isSignedAmount(opening)) {
      setProblem(t('cashbook.accounts.openingInvalid'));
      return;
    }
    setProblem(null);
    create.mutate();
  };

  return (
    <div>
      <Typography.Title level={3}>{t('cashbook.accounts.title')}</Typography.Title>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Checkbox checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)}>
        {t('cashbook.accounts.showInactive')}
      </Checkbox>
      <Table<Account>
        rowKey="id"
        size="small"
        pagination={false}
        style={{ margin: '12px 0' }}
        locale={{ emptyText: t('cashbook.accounts.empty') }}
        dataSource={list.data ?? []}
        columns={[
          { title: t('cashbook.account.code'), dataIndex: 'code' },
          { title: t('cashbook.account.name'), dataIndex: 'name' },
          { title: t('cashbook.account.kind'), render: (_, row) => t(`cashbook.kind.${row.kind}`) },
          {
            title: t('cashbook.account.opening'),
            align: 'right',
            render: (_, row) =>
              `${formatAmount(row.openingBalance)} (${formatDate(row.openingDate)})`,
          },
          {
            title: t('cashbook.account.balance'),
            align: 'right',
            render: (_, row) => formatAmount(row.balance ?? row.openingBalance),
          },
          {
            title: t('cashbook.account.status'),
            render: (_, row) =>
              row.active ? (
                <Tag color="green">{t('cashbook.account.active')}</Tag>
              ) : (
                <Tag>{t('cashbook.account.inactive')}</Tag>
              ),
          },
          {
            title: '',
            render: (_, row) =>
              can(perm.accountManage) && (
                <Button size="small" onClick={() => toggle.mutate(row)}>
                  {row.active ? t('cashbook.account.deactivate') : t('cashbook.account.activate')}
                </Button>
              ),
          },
        ]}
      />
      {can(perm.accountManage) && (
        <div>
          <Typography.Title level={4}>{t('cashbook.accounts.new')}</Typography.Title>
          {problem !== null && (
            <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />
          )}
          <Space wrap align="end">
            <Input
              aria-label={t('cashbook.account.code')}
              placeholder={t('cashbook.account.code')}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Input
              aria-label={t('cashbook.account.name')}
              placeholder={t('cashbook.account.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Select
              aria-label={t('cashbook.account.kind')}
              style={{ width: 160 }}
              value={kind}
              onChange={setKind}
              options={cashAccountKinds.map((value) => ({
                value,
                label: t(`cashbook.kind.${value}`),
              }))}
            />
            <Input
              aria-label={t('cashbook.account.opening')}
              placeholder={t('cashbook.account.opening')}
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
            />
            <Input
              aria-label={t('cashbook.account.openingDate')}
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
            />
            <Input
              aria-label={t('cashbook.account.bankName')}
              placeholder={t('cashbook.account.bankName')}
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
            />
            <Input
              aria-label={t('cashbook.account.masked')}
              placeholder="****1234"
              value={masked}
              onChange={(e) => setMasked(e.target.value)}
            />
            <Input
              aria-label={t('cashbook.account.tag')}
              placeholder={t('cashbook.account.tag')}
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
            <Checkbox checked={overdraft} onChange={(e) => setOverdraft(e.target.checked)}>
              {t('cashbook.account.allowOverdraft')}
            </Checkbox>
            <Button type="primary" loading={create.isPending} onClick={submit}>
              {t('cashbook.accounts.create')}
            </Button>
          </Space>
        </div>
      )}
    </div>
  );
}
