import { formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Table, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { wagesApi, type ReconciliationRow } from './api';

/** BR-12: the labour cost attendance allocated to projects against the gross pay, by worker. */
export function WageReconciliationPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const data = useQuery({
    queryKey: ['wage-reconciliation', id],
    queryFn: () => wagesApi.reconciliation(id),
  });
  const result = data.data;

  return (
    <div>
      <Typography.Title level={3}>{t('wages.reconciliation.title')}</Typography.Title>
      <Link to={`/wages/periods/${id}`}>{t('wages.reconciliation.back')}</Link>
      {data.isError && <Alert type="error" message={t('common.loadError')} />}
      {result !== undefined && (
        <Typography.Paragraph style={{ marginTop: 12 }}>
          {t('wages.reconciliation.totals', {
            allocated: formatAmount(result.totals.allocated),
            gross: formatAmount(result.totals.gross),
            difference: formatAmount(result.totals.difference),
          })}
        </Typography.Paragraph>
      )}
      <Table<ReconciliationRow>
        size="small"
        rowKey="workerId"
        pagination={false}
        dataSource={result?.rows ?? []}
        locale={{ emptyText: t('wages.reconciliation.empty') }}
        rowClassName={(row) => (Number(row.difference) === 0 ? '' : 'wage-difference')}
        columns={[
          {
            title: t('wages.column.worker'),
            render: (_, r) => `${r.workerCode ?? ''} ${r.workerName ?? ''}`.trim() || r.workerId,
          },
          {
            title: t('wages.reconciliation.allocated'),
            render: (_, r) => formatAmount(r.allocated),
          },
          { title: t('wages.reconciliation.gross'), render: (_, r) => formatAmount(r.gross) },
          {
            title: t('wages.reconciliation.difference'),
            render: (_, r) =>
              Number(r.difference) === 0 ? (
                formatAmount(r.difference)
              ) : (
                <strong>{formatAmount(r.difference)}</strong>
              ),
          },
        ]}
      />
    </div>
  );
}
