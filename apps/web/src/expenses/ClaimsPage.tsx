import { expensesPermissions as perm, formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { expensesApi, type ClaimHeader } from './api';
import { useErrorText } from './shared';

export type ClaimsView = 'mine' | 'all' | 'queue';

const titles: Record<ClaimsView, string> = {
  mine: 'expenses.claims.title',
  all: 'expenses.claims.allTitle',
  queue: 'expenses.claims.queueTitle',
};

/** My claims, every claim (finance and management) or the accountant's posting queue. */
export function ClaimsPage({ view }: { view: ClaimsView }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['expense-claims', view],
    queryFn: () =>
      expensesApi.claims({
        ...(view === 'mine' ? { mine: true } : {}),
        ...(view === 'queue' ? { status: 'approved' as const } : {}),
      }),
  });

  const post = useMutation({
    mutationFn: (claim: ClaimHeader) => expensesApi.post(claim.id, claim.version),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['expense-claims'] });
    },
    onError: (cause) => setError(errorText(cause)),
  });

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t(titles[view])}
        </Typography.Title>
        {view === 'mine' && can(perm.claimCreate) && (
          <Link to="/expenses/claims/new">
            <Button type="primary">{t('expenses.claims.new')}</Button>
          </Link>
        )}
      </Space>
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<ClaimHeader>
        rowKey="id"
        size="small"
        scroll={{ x: 'max-content' }}
        loading={list.isLoading}
        locale={{
          emptyText: t(view === 'queue' ? 'expenses.claims.queueEmpty' : 'expenses.claims.empty'),
        }}
        dataSource={list.data?.items ?? []}
        columns={[
          {
            title: t('expenses.field.number'),
            render: (_, claim) => <Link to={`/expenses/claims/${claim.id}`}>{claim.number}</Link>,
          },
          {
            title: t('expenses.field.submittedOn'),
            render: (_, claim) => (claim.submittedOn === null ? '' : formatDate(claim.submittedOn)),
          },
          {
            title: t('expenses.field.status'),
            render: (_, claim) => <Tag>{t(`expenses.status.${claim.status}`)}</Tag>,
          },
          {
            title: t('expenses.field.total'),
            align: 'right',
            render: (_, claim) => formatAmount(claim.total),
          },
          ...(view === 'queue' && can(perm.claimPost)
            ? [
                {
                  title: '',
                  render: (_: unknown, claim: ClaimHeader) => (
                    <Button
                      size="small"
                      type="primary"
                      loading={post.isPending}
                      onClick={() => post.mutate(claim)}
                    >
                      {t('expenses.action.post')}
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
