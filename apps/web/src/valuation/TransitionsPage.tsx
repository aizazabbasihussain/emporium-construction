import { formatAmount, formatDateTimeUtc, valuationPermissions } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { valuationApi, type Transition } from './api';

const PAGE_SIZE = 20;

/** The transition log, with the admin action that runs the pending conversions now (BR-11). */
export function TransitionsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const log = useQuery({
    queryKey: ['valuation', 'transitions', page],
    queryFn: () => valuationApi.transitions((page - 1) * PAGE_SIZE, PAGE_SIZE),
  });
  const run = useMutation({
    mutationFn: valuationApi.runTransitions,
    onSuccess: async (result) => {
      setMessage({
        type: 'success',
        text: t('valuation.transitions.ran', { count: result.items.length }),
      });
      await queryClient.invalidateQueries({ queryKey: ['valuation'] });
    },
    onError: (cause) =>
      setMessage({
        type: 'error',
        text:
          cause instanceof ApiError
            ? t(`valuation.errors.${cause.code}`, { defaultValue: cause.message })
            : t('common.saveError'),
      }),
  });

  return (
    <div>
      <Typography.Title level={3}>{t('valuation.transitions.title')}</Typography.Title>
      <Typography.Paragraph>{t('valuation.transitions.hint')}</Typography.Paragraph>
      {log.isError && <Alert type="error" message={t('common.loadError')} />}
      {message !== null && <Alert type={message.type} message={message.text} />}
      {can(valuationPermissions.transitionRun) && (
        <Button
          type="primary"
          loading={run.isPending}
          onClick={() => run.mutate()}
          style={{ margin: '12px 0' }}
        >
          {t('valuation.transitions.run')}
        </Button>
      )}
      <Table<Transition>
        rowKey="id"
        loading={log.isLoading}
        locale={{ emptyText: t('valuation.transitions.empty') }}
        dataSource={log.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: log.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          { title: t('valuation.report.item'), dataIndex: 'itemId' },
          { title: t('valuation.report.store'), dataIndex: 'storeId' },
          {
            title: t('valuation.transitions.from'),
            render: (_, row) => t(`valuation.method.${row.fromMethod}`),
          },
          {
            title: t('valuation.transitions.to'),
            render: (_, row) => t(`valuation.method.${row.toMethod}`),
          },
          { title: t('valuation.transitions.quantity'), dataIndex: 'quantity', align: 'right' },
          {
            title: t('valuation.transitions.before'),
            align: 'right',
            render: (_, row) => formatAmount(row.valueBefore),
          },
          {
            title: t('valuation.transitions.after'),
            align: 'right',
            render: (_, row) => formatAmount(row.valueAfter),
          },
          {
            title: t('valuation.transitions.completedAt'),
            render: (_, row) => formatDateTimeUtc(row.completedAt),
          },
        ]}
      />
    </div>
  );
}
