import { formatAmount, wagesPermissions as perm } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { karachiToday } from '../attendance/form';
import { wagesApi, type Period } from './api';
import { monthKeys, useErrorText } from './form';

/** The wage periods, one per calendar month, and the form that opens the next one. */
export function WagePeriodsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const today = karachiToday();
  const [year, setYear] = useState(today.slice(0, 4));
  const [month, setMonth] = useState(String(Number(today.slice(5, 7))));
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['wage-periods'], queryFn: () => wagesApi.periods() });
  const create = useMutation({
    mutationFn: () => wagesApi.create(Number(year), Number(month)),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['wage-periods'] });
    },
    onError: (cause) => setError(errorText(cause)),
  });

  return (
    <div>
      <Typography.Title level={3}>{t('wages.periods.title')}</Typography.Title>
      {can(perm.periodCalculate) && (
        <Space style={{ marginBottom: 12 }} wrap>
          <Input
            type="number"
            aria-label={t('wages.periods.year')}
            style={{ width: 100 }}
            value={year}
            onChange={(event) => setYear(event.target.value)}
          />
          <select
            aria-label={t('wages.periods.month')}
            style={{ padding: '4px 6px' }}
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          >
            {monthKeys.map((key, index) => (
              <option key={key} value={String(index + 1)}>
                {t(`wages.month.${key}`)}
              </option>
            ))}
          </select>
          <Button type="primary" loading={create.isPending} onClick={() => create.mutate()}>
            {t('wages.periods.open')}
          </Button>
        </Space>
      )}
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<Period>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={list.data?.items ?? []}
        locale={{ emptyText: t('wages.periods.empty') }}
        columns={[
          {
            title: t('wages.periods.period'),
            render: (_, p) => `${t(`wages.month.${monthKeys[p.month - 1] as string}`)} ${p.year}`,
          },
          {
            title: t('wages.periods.status'),
            render: (_, p) => <Tag>{t(`wages.periodStatus.${p.status}`)}</Tag>,
          },
          {
            title: t('wages.periods.net'),
            render: (_, p) => (p.totalNet === '0.00' ? '' : formatAmount(p.totalNet)),
          },
          {
            title: '',
            render: (_, p) => (
              <Link to={`/wages/periods/${p.id}`}>{t('wages.periods.openSheet')}</Link>
            ),
          },
        ]}
      />
    </div>
  );
}
