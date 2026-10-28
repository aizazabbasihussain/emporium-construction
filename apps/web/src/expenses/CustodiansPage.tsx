import { expensesPermissions as perm, formatAmount } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { expensesApi, type Custodian } from './api';
import { useErrorText } from './shared';

/** Who holds petty cash, their float limit and what they are owed or owe (BR-1). */
export function CustodiansPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [person, setPerson] = useState('');
  const [floatLimit, setFloatLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const manage = can(perm.advanceIssue);

  const custodians = useQuery({
    queryKey: ['expense-custodians'],
    queryFn: expensesApi.custodians,
  });
  const candidates = useQuery({
    queryKey: ['expense-candidates'],
    queryFn: expensesApi.candidates,
    enabled: manage,
  });
  const nameOf = (id: string) => candidates.data?.find((c) => c.id === id)?.fullName ?? id;

  const save = useMutation({
    mutationFn: (input: {
      userId: string;
      floatLimit: string;
      active: boolean;
      version?: number;
    }) =>
      expensesApi.saveCustodian(input.userId, {
        floatLimit: input.floatLimit,
        active: input.active,
        ...(input.version === undefined ? {} : { version: input.version }),
      }),
    onSuccess: async () => {
      setError(null);
      setPerson('');
      setFloatLimit('');
      await queryClient.invalidateQueries({ queryKey: ['expense-custodians'] });
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const register = () => {
    if (person === '' || !/^\d+(\.\d{1,2})?$/.test(floatLimit.trim())) {
      setError(t('expenses.custodians.incomplete'));
      return;
    }
    setError(null);
    save.mutate({ userId: person, floatLimit: floatLimit.trim(), active: true });
  };

  return (
    <div>
      <Typography.Title level={3}>{t('expenses.custodians.title')}</Typography.Title>
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {manage && (
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            aria-label={t('expenses.custodians.person')}
            placeholder={t('expenses.custodians.person')}
            showSearch
            optionFilterProp="label"
            style={{ width: 240 }}
            value={person === '' ? undefined : person}
            options={(candidates.data ?? []).map((c) => ({ value: c.id, label: c.fullName }))}
            onChange={setPerson}
          />
          <Input
            aria-label={t('expenses.custodians.floatLimit')}
            placeholder={t('expenses.custodians.floatLimit')}
            inputMode="decimal"
            style={{ width: 160 }}
            value={floatLimit}
            onChange={(event) => setFloatLimit(event.target.value)}
          />
          <Button type="primary" loading={save.isPending} onClick={register}>
            {t('expenses.custodians.save')}
          </Button>
        </Space>
      )}
      <Table<Custodian>
        rowKey="userId"
        size="small"
        scroll={{ x: 'max-content' }}
        loading={custodians.isLoading}
        locale={{ emptyText: t('expenses.custodians.empty') }}
        dataSource={custodians.data ?? []}
        columns={[
          { title: t('expenses.custodians.name'), render: (_, c) => nameOf(c.userId) },
          {
            title: t('expenses.custodians.floatLimit'),
            align: 'right',
            render: (_, c) => formatAmount(c.floatLimit),
          },
          {
            title: t('expenses.custodians.balance'),
            align: 'right',
            render: (_, c) => (
              <span>
                {formatAmount(c.balance)}{' '}
                {c.balance.startsWith('-') && (
                  <Tag color="orange">{t('expenses.custodians.owed')}</Tag>
                )}
              </span>
            ),
          },
          {
            title: t('expenses.custodians.active'),
            render: (_, c) => (c.active ? t('common.yes') : t('common.no')),
          },
        ]}
      />
    </div>
  );
}
