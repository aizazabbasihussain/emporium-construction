import { formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Select, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { taxApi, type ReportTotals } from './api';

const thisMonth = () => new Date().toISOString().slice(0, 7);

interface Line extends ReportTotals {
  key: string;
}

/** Output tax, input tax and withholding for one authority and month (spec P2-01 BR-8). */
export function TaxReportPage() {
  const { t } = useTranslation();
  const [authority, setAuthority] = useState('');
  const [month, setMonth] = useState(thisMonth());

  const overview = useQuery({ queryKey: ['tax', 'rules'], queryFn: taxApi.overview });
  const authorityCode = authority !== '' ? authority : (overview.data?.authorities[0]?.code ?? '');
  const report = useQuery({
    queryKey: ['tax', 'report', authorityCode, month],
    queryFn: () => taxApi.report(authorityCode, month),
    enabled: authorityCode !== '' && /^\d{4}-\d{2}$/.test(month),
  });

  const data = report.data;
  const lines: Line[] =
    data === undefined
      ? []
      : [
          { key: 'outputTax', ...data.outputTax },
          { key: 'inputTax', ...data.inputTax },
          { key: 'withholdingDeducted', ...data.withholdingDeducted },
          { key: 'withholdingSuffered', ...data.withholdingSuffered },
        ];

  return (
    <div>
      <Typography.Title level={3}>{t('tax.report.title')}</Typography.Title>
      <Typography.Paragraph>{t('tax.report.hint')}</Typography.Paragraph>
      {report.isError && <Alert type="error" message={t('common.loadError')} />}
      <div style={{ display: 'flex', gap: 12, margin: '12px 0' }}>
        <Select
          aria-label={t('tax.fields.authority')}
          style={{ width: 260 }}
          value={authorityCode === '' ? undefined : authorityCode}
          onChange={setAuthority}
          options={(overview.data?.authorities ?? []).map((entry) => ({
            value: entry.code,
            label: `${entry.code} - ${entry.name}`,
          }))}
        />
        <Input
          type="month"
          aria-label={t('tax.fields.month')}
          style={{ width: 180 }}
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
      </div>
      <Table<Line>
        rowKey="key"
        size="small"
        pagination={false}
        locale={{ emptyText: t('tax.report.none') }}
        dataSource={lines}
        columns={[
          { title: t('tax.report.kind'), render: (_, row) => t(`tax.report.${row.key}`) },
          {
            title: t('tax.report.base'),
            align: 'right',
            render: (_, row) => formatAmount(row.base),
          },
          { title: t('tax.report.tax'), align: 'right', render: (_, row) => formatAmount(row.tax) },
          { title: t('tax.report.documents'), align: 'right', dataIndex: 'documents' },
        ]}
      />
    </div>
  );
}
