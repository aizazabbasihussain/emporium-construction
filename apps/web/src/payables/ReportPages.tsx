import { formatAmount, formatDate } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { payablesApi, type Aging, type VendorLedger, type WithholdingReport } from './api';
import { today, useVendors } from './hooks';

/** The vendor ledger: balance (withholding payable shown apart), lines and open bills (BR-9). */
export function VendorLedgerPage() {
  const { t } = useTranslation();
  const { options } = useVendors();
  const [vendorId, setVendorId] = useState('');
  const ledger = useQuery({
    queryKey: ['payables', 'ledger', vendorId],
    queryFn: () => payablesApi.ledger(vendorId),
    enabled: vendorId !== '',
  });
  const data: VendorLedger | undefined = ledger.data;
  return (
    <div>
      <Typography.Title level={3}>{t('payables.ledger.title')}</Typography.Title>
      <Select
        aria-label={t('payables.common.vendor')}
        placeholder={t('payables.common.vendor')}
        showSearch
        optionFilterProp="label"
        style={{ width: 320, marginBottom: 12 }}
        value={vendorId === '' ? undefined : vendorId}
        onChange={setVendorId}
        options={options}
      />
      {ledger.isError && <Alert type="error" message={t('common.loadError')} />}
      {data !== undefined && (
        <>
          <Space direction="vertical" style={{ marginBottom: 12 }}>
            <div>
              {t('payables.ledger.net')}: {formatAmount(data.balance.netPayable)}
            </div>
            <div>
              {t('payables.ledger.withholdingPayable')}:{' '}
              {formatAmount(data.balance.withholdingPayable)}
            </div>
            <div>
              {t('payables.ledger.payments')}: {formatAmount(data.balance.payments)}
            </div>
            <strong>
              {t('payables.ledger.balance')}: {formatAmount(data.balance.balance)}
            </strong>
          </Space>
          <Table
            rowKey="documentId"
            size="small"
            pagination={false}
            locale={{ emptyText: t('payables.ledger.none') }}
            dataSource={data.lines}
            columns={[
              { title: t('payables.common.date'), render: (_, row) => formatDate(row.date) },
              { title: t('payables.ledger.reference'), dataIndex: 'reference' },
              {
                title: t('payables.ledger.debit'),
                align: 'right',
                render: (_, row) => formatAmount(row.debit),
              },
              {
                title: t('payables.ledger.credit'),
                align: 'right',
                render: (_, row) => formatAmount(row.credit),
              },
              {
                title: t('payables.ledger.balance'),
                align: 'right',
                render: (_, row) => formatAmount(row.balance),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

type AgingRow = Aging['rows'][number];

/** Open bills by due date in the receivables buckets (BR-9). */
export function PayablesAgingPage() {
  const { t } = useTranslation();
  const { nameOf } = useVendors();
  const [asOf, setAsOf] = useState(today());
  const report = useQuery({
    queryKey: ['payables', 'aging', asOf],
    queryFn: () => payablesApi.aging(asOf),
    enabled: asOf !== '',
  });
  const data = report.data;
  return (
    <div>
      <Typography.Title level={3}>{t('payables.aging.title')}</Typography.Title>
      <Input
        aria-label={t('payables.aging.asOf')}
        type="date"
        value={asOf}
        onChange={(e) => setAsOf(e.target.value)}
        style={{ width: 200, marginBottom: 12 }}
      />
      {report.isError && <Alert type="error" message={t('common.loadError')} />}
      {data !== undefined && (
        <Table<AgingRow>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={data.rows}
          columns={[
            { title: t('payables.common.vendor'), render: (_, row) => nameOf(row.key) },
            ...data.labels.map((name, index) => ({
              title: index === 0 ? t('payables.aging.current') : name,
              align: 'right' as const,
              render: (_: unknown, row: AgingRow) => formatAmount(row.buckets[index] as string),
            })),
            {
              title: t('payables.aging.total'),
              align: 'right' as const,
              render: (_: unknown, row: AgingRow) => formatAmount(row.total),
            },
          ]}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>{t('payables.aging.total')}</Table.Summary.Cell>
              {data.totals.map((value, index) => (
                <Table.Summary.Cell key={data.labels[index]} index={index + 1} align="right">
                  {formatAmount(value)}
                </Table.Summary.Cell>
              ))}
              <Table.Summary.Cell index={data.totals.length + 1} align="right">
                <strong>{formatAmount(data.total)}</strong>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      )}
    </div>
  );
}

type WithholdingRow = WithholdingReport['rows'][number];

/** Withholding deducted per authority and month for the accountant's report (BR-8). */
export function WithholdingReportPage() {
  const { t } = useTranslation();
  const { nameOf } = useVendors();
  const [month, setMonth] = useState(today().slice(0, 7));
  const report = useQuery({
    queryKey: ['payables', 'withholding', month],
    queryFn: () => payablesApi.withholding(month),
    enabled: /^\d{4}-(0[1-9]|1[0-2])$/.test(month),
  });
  const data = report.data;
  return (
    <div>
      <Typography.Title level={3}>{t('payables.withholding.title')}</Typography.Title>
      <Input
        aria-label={t('payables.withholding.month')}
        type="month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        style={{ width: 200, marginBottom: 12 }}
      />
      {report.isError && <Alert type="error" message={t('common.loadError')} />}
      {data !== undefined && (
        <>
          {data.totals.map((row) => (
            <p key={`${row.authorityCode}|${row.month}`}>
              <strong>
                {t('payables.withholding.total', {
                  authority: row.authorityCode,
                  month: row.month,
                  amount: formatAmount(row.amount),
                })}
              </strong>
            </p>
          ))}
          <Table<WithholdingRow>
            rowKey={(row) => `${row.paymentId}|${row.billId}`}
            size="small"
            pagination={false}
            locale={{ emptyText: t('payables.withholding.none') }}
            dataSource={data.rows}
            columns={[
              { title: t('payables.withholding.authority'), dataIndex: 'authorityCode' },
              { title: t('payables.common.vendor'), render: (_, row) => nameOf(row.vendorPartyId) },
              { title: t('payables.payments.number'), dataIndex: 'paymentNumber' },
              { title: t('payables.bills.number'), dataIndex: 'billNumber' },
              {
                title: t('payables.common.amount'),
                align: 'right',
                render: (_, row) => formatAmount(row.amount),
              },
              {
                title: t('payables.withholding.certificate'),
                render: (_, row) => row.certificateNo ?? '',
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
