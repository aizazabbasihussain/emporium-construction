import {
  accountingPermissions,
  exportCodes,
  formatAmount,
  formatDateTimeUtc,
  type ExportCode,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { accountingApi, type Run, type RunResult } from './api';
import { useErrorText } from './useErrorText';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

/** The exports hub: choose an export and a period, run it, download it, see earlier runs (BR-3, BR-6). */
export function ExportsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [code, setCode] = useState<ExportCode>(exportCodes[0]);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [side, setSide] = useState<'receivable' | 'payable' | ''>('');
  const [authority, setAuthority] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const info = useQuery({ queryKey: ['accounting', 'exports'], queryFn: accountingApi.exports });
  const runs = useQuery({
    queryKey: ['accounting', 'runs'],
    queryFn: () => accountingApi.runs(),
    retry: false,
  });
  const layout = info.data?.find((item) => item.code === code);
  const nameOf = (value: string) => t(`accounting.exports.names.${value}`, { defaultValue: value });

  const run = useMutation({
    mutationFn: () =>
      accountingApi.run(code, {
        from,
        to,
        ...(code === 'aging' && side !== '' ? { side } : {}),
        ...(code === 'withholding_report' && authority.trim() !== ''
          ? { authorityCode: authority.trim() }
          : {}),
      }),
    onSuccess: async (data) => {
      setError(null);
      setResult(data);
      await queryClient.invalidateQueries({ queryKey: ['accounting', 'runs'] });
    },
    onError: (cause) => {
      setResult(null);
      setError(errorText(cause));
    },
  });

  const download = async (fileId: string) => {
    try {
      window.open((await accountingApi.fileUrl(fileId)).url, '_blank');
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const canRun = can(accountingPermissions.exportRun);
  return (
    <div>
      <Typography.Title level={3}>{t('accounting.exports.title')}</Typography.Title>
      <Typography.Paragraph>{t('accounting.exports.intro')}</Typography.Paragraph>
      {error !== null && <Alert type="error" message={error} />}
      {info.isError && <Alert type="error" message={errorText(info.error)} />}

      <Space wrap align="end" style={{ margin: '12px 0' }}>
        <label>
          <div>{t('accounting.exports.export')}</div>
          <Select
            aria-label={t('accounting.exports.export')}
            style={{ width: 280 }}
            value={code}
            onChange={(value) => {
              setCode(value);
              setResult(null);
            }}
            options={exportCodes.map((value) => ({ value, label: nameOf(value) }))}
          />
        </label>
        <label>
          <div>{t('accounting.exports.from')}</div>
          <Input
            aria-label={t('accounting.exports.from')}
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          <div>{t('accounting.exports.to')}</div>
          <Input
            aria-label={t('accounting.exports.to')}
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        {code === 'aging' && (
          <label>
            <div>{t('accounting.exports.side')}</div>
            <Select
              aria-label={t('accounting.exports.side')}
              style={{ width: 160 }}
              value={side}
              onChange={setSide}
              options={[
                { value: '', label: t('accounting.exports.sideAll') },
                { value: 'receivable', label: t('accounting.exports.receivable') },
                { value: 'payable', label: t('accounting.exports.payable') },
              ]}
            />
          </label>
        )}
        {code === 'withholding_report' && (
          <label>
            <div>{t('accounting.exports.authority')}</div>
            <Input
              aria-label={t('accounting.exports.authority')}
              style={{ width: 120 }}
              value={authority}
              onChange={(event) => setAuthority(event.target.value)}
            />
          </label>
        )}
        {canRun && (
          <Button
            type="primary"
            loading={run.isPending}
            disabled={from === '' || to === ''}
            onClick={() => run.mutate()}
          >
            {t('accounting.exports.run')}
          </Button>
        )}
      </Space>
      {layout !== undefined && (
        <Typography.Paragraph type="secondary">
          {t('accounting.exports.layout')}: {t('accounting.exports.schemaVersion')}{' '}
          {layout.schemaVersion}. {t('accounting.exports.columns')}:{' '}
          {layout.columns.map((column) => column.key).join(', ')}
        </Typography.Paragraph>
      )}

      {result !== null && (
        <div style={{ margin: '12px 0' }}>
          <Alert
            type={result.untagged > 0 ? 'warning' : 'success'}
            message={`${t('accounting.exports.result')}: ${t('accounting.exports.rows')} ${result.run.rowCount}`}
            description={
              result.untagged > 0 ? (
                <span>
                  {t('accounting.exports.untaggedWarning', { count: result.untagged })}{' '}
                  <Link to="/accounting/untagged">{t('nav.accountingUntagged')}</Link>
                </span>
              ) : (
                t('accounting.exports.allTagged')
              )
            }
          />
          <Space style={{ margin: '8px 0' }}>
            <Button onClick={() => void download(result.files.xlsx)}>
              {t('accounting.exports.excel')}
            </Button>
            <Button onClick={() => void download(result.files.csv)}>
              {t('accounting.exports.csv')}
            </Button>
          </Space>
          <Typography.Paragraph>
            {t('accounting.exports.totals')}:{' '}
            {Object.entries(result.totals)
              .map(([key, value]) => `${key} ${formatAmount(value)}`)
              .join('; ')}
          </Typography.Paragraph>
        </div>
      )}

      <Typography.Title level={4}>{t('accounting.exports.history')}</Typography.Title>
      <Table<Run>
        size="small"
        rowKey="id"
        loading={runs.isLoading}
        pagination={false}
        dataSource={runs.data?.items ?? []}
        locale={{ emptyText: t('accounting.exports.noRuns') }}
        columns={[
          {
            key: 'at',
            title: t('accounting.exports.runAt'),
            render: (_, row) => formatDateTimeUtc(row.runAt),
          },
          {
            key: 'export',
            title: t('accounting.exports.export'),
            render: (_, row) => nameOf(row.exportCode),
          },
          {
            key: 'period',
            title: t('accounting.exports.period'),
            render: (_, row) => `${row.filters.from ?? ''} - ${row.filters.to ?? ''}`,
          },
          { key: 'rows', title: t('accounting.exports.rows'), dataIndex: 'rowCount' },
          {
            key: 'sum',
            title: t('accounting.exports.checksum'),
            render: (_, row) => row.checksumSha256.slice(0, 12),
          },
          {
            key: 'file',
            title: t('accounting.exports.download'),
            render: (_, row) =>
              row.fileId === null ? null : (
                <Button size="small" onClick={() => void download(row.fileId as string)}>
                  {t('accounting.exports.excel')}
                </Button>
              ),
          },
        ]}
      />
    </div>
  );
}
