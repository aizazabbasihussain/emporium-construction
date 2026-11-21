import { formatAmount } from '@emporium/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { profitabilityApi, type PortfolioRow } from './api';

export const percentText = (value: string | null, fallback: string): string =>
  value === null ? fallback : `${value}%`;

export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`profitability.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.loadError');
}

export function AlertTags({ codes }: { codes: PortfolioRow['alerts'] }) {
  const { t } = useTranslation();
  if (codes.length === 0) return <>{t('profitability.portfolio.noAlerts')}</>;
  return (
    <Space size={4} wrap>
      {codes.map((code) => (
        <Tag key={code} color="red">
          {t(`profitability.alerts.${code}`)}
        </Tag>
      ))}
    </Space>
  );
}

/** BR-5: every project with its contract, billing, collection, cost, margin and cash, riskiest first. */
export function PortfolioPage() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [draftDate, setDraftDate] = useState('');
  const [asOf, setAsOf] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const portfolio = useQuery({
    queryKey: ['profitability', 'portfolio', asOf, status],
    queryFn: () => profitabilityApi.portfolio({ asOf: asOf || undefined, status }),
    retry: false,
  });
  const download = useMutation({
    mutationFn: (format: 'csv' | 'xlsx') =>
      profitabilityApi.download({ asOf: asOf || undefined, status }, format),
    onError: (cause) => setError(errorText(cause)),
  });
  const na = t('profitability.project.notComputable');

  return (
    <div>
      <Typography.Title level={3}>{t('profitability.title')}</Typography.Title>
      <Typography.Paragraph>{t('profitability.portfolio.intro')}</Typography.Paragraph>
      {error !== null && <Alert type="error" message={error} />}
      {portfolio.isError && <Alert type="error" message={errorText(portfolio.error)} />}

      <Space wrap style={{ margin: '12px 0' }}>
        <Input
          type="date"
          aria-label={t('profitability.portfolio.asOf')}
          style={{ width: 170 }}
          value={draftDate}
          onChange={(event) => setDraftDate(event.target.value)}
          onBlur={() => setAsOf(draftDate)}
        />
        <Select
          allowClear
          aria-label={t('profitability.portfolio.status')}
          placeholder={t('profitability.portfolio.allStatuses')}
          style={{ width: 180 }}
          value={status}
          onChange={(value: string | undefined) => setStatus(value)}
          options={['planning', 'active', 'on_hold', 'completed', 'cancelled'].map((value) => ({
            value,
            label: value,
          }))}
        />
        <Button loading={download.isPending} onClick={() => download.mutate('csv')}>
          {t('profitability.portfolio.exportCsv')}
        </Button>
        <Button loading={download.isPending} onClick={() => download.mutate('xlsx')}>
          {t('profitability.portfolio.exportXlsx')}
        </Button>
        <Link to="/profitability/alerts">{t('profitability.portfolio.alertsLink')}</Link>
      </Space>

      <Table<PortfolioRow>
        size="small"
        rowKey="projectId"
        loading={portfolio.isLoading}
        pagination={false}
        dataSource={portfolio.data?.items ?? []}
        locale={{ emptyText: t('profitability.portfolio.empty') }}
        columns={[
          {
            key: 'project',
            title: t('profitability.columns.project'),
            render: (_, row) => (
              <Link to={`/profitability/projects/${row.projectId}`}>
                {row.code} {row.name}
              </Link>
            ),
          },
          {
            key: 'contractValue',
            title: t('profitability.columns.contractValue'),
            align: 'right',
            render: (_, row) => formatAmount(row.contractValue),
          },
          {
            key: 'billedPercent',
            title: t('profitability.columns.billedPercent'),
            align: 'right',
            render: (_, row) => percentText(row.billedPercent, na),
          },
          {
            key: 'collectedPercent',
            title: t('profitability.columns.collectedPercent'),
            align: 'right',
            render: (_, row) => percentText(row.collectedPercent, na),
          },
          {
            key: 'costPercentOfBudget',
            title: t('profitability.columns.costPercentOfBudget'),
            align: 'right',
            render: (_, row) => percentText(row.costPercentOfBudget, na),
          },
          {
            key: 'expectedMargin',
            title: t('profitability.columns.expectedMargin'),
            align: 'right',
            render: (_, row) =>
              `${formatAmount(row.expectedMargin)} (${percentText(row.expectedMarginPercent, na)})`,
          },
          {
            key: 'cashPosition',
            title: t('profitability.columns.cashPosition'),
            align: 'right',
            render: (_, row) => (
              <Typography.Text type={row.cashPosition.startsWith('-') ? 'danger' : undefined}>
                {formatAmount(row.cashPosition)}
              </Typography.Text>
            ),
          },
          {
            key: 'alerts',
            title: t('profitability.columns.alerts'),
            render: (_, row) => <AlertTags codes={row.alerts} />,
          },
        ]}
      />
    </div>
  );
}
