import { formatAmount, formatDate } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { masterApi, type Party } from '../master/api';
import { receivablesApi, type OpenInvoice, type Receipt, type StatementLine } from './api';

const today = () => new Date().toISOString().slice(0, 10);

/** The customer ledger and the printable statement (BR-1, BR-10). */
export function CustomerLedgerPage() {
  const { t } = useTranslation();
  const [partyId, setPartyId] = useState('');
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());

  const customers = useQuery({
    queryKey: ['master-parties', 'clients'],
    queryFn: () =>
      masterApi.listAll<Party>('/master/parties', { role: 'client', status: 'active' }),
  });
  const ledger = useQuery({
    queryKey: ['receivables', 'ledger', partyId],
    queryFn: () => receivablesApi.ledger(partyId),
    enabled: partyId !== '',
  });
  const statement = useQuery({
    queryKey: ['receivables', 'statement', partyId, from, to],
    queryFn: () => receivablesApi.statement(partyId, from, to),
    enabled: partyId !== '' && from !== '' && to !== '',
  });
  const balance = ledger.data?.balance;

  return (
    <div>
      <Typography.Title level={3}>{t('receivables.ledger.title')}</Typography.Title>
      <Select
        aria-label={t('receivables.common.customer')}
        placeholder={t('receivables.ledger.choose')}
        showSearch
        optionFilterProp="label"
        value={partyId === '' ? undefined : partyId}
        onChange={setPartyId}
        options={(customers.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
        style={{ width: 320, marginBottom: 12 }}
      />
      {ledger.isError && <Alert type="error" message={t('common.loadError')} />}
      {balance !== undefined && (
        <Space size="large" wrap style={{ marginBottom: 12 }}>
          {(
            [
              ['balance', balance.balance],
              ['credit', balance.credit],
              ['invoiced', balance.invoiced],
              ['credited', balance.credited],
              ['receipts', balance.receipts],
              ['withholding', balance.withholding],
              ['adjustments', balance.adjustments],
            ] as const
          ).map(([key, value]) => (
            <div key={key}>
              <div>{t(`receivables.ledger.${key}`)}</div>
              <strong aria-label={t(`receivables.ledger.${key}`)}>{formatAmount(value)}</strong>
            </div>
          ))}
        </Space>
      )}
      {ledger.data !== undefined && (
        <>
          <Typography.Title level={5}>{t('receivables.ledger.openInvoices')}</Typography.Title>
          <Table<OpenInvoice>
            rowKey="invoiceId"
            size="small"
            pagination={false}
            dataSource={ledger.data.openInvoices}
            columns={[
              {
                title: t('receivables.receipt.invoice'),
                render: (_, row) => row.number ?? row.invoiceId,
              },
              {
                title: t('receivables.receipt.dueDate'),
                render: (_, row) => formatDate(row.dueDate),
              },
              {
                title: t('receivables.receipt.outstanding'),
                align: 'right',
                render: (_, row) => formatAmount(row.outstanding),
              },
            ]}
          />
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            {t('receivables.ledger.receiptsTitle')}
          </Typography.Title>
          <Table<Receipt>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={ledger.data.receipts.items}
            columns={[
              { title: '#', render: (_, row) => row.number },
              {
                title: t('receivables.common.date'),
                render: (_, row) => formatDate(row.receiptDate),
              },
              {
                title: t('receivables.receipt.method'),
                render: (_, row) => t(`receivables.method.${row.method}`),
              },
              {
                title: t('receivables.common.amount'),
                align: 'right',
                render: (_, row) => formatAmount(row.amount),
              },
              {
                title: t('receivables.pdc.status'),
                render: (_, row) => t(`receivables.status.${row.status}`),
              },
            ]}
          />
        </>
      )}
      {partyId !== '' && (
        <div style={{ marginTop: 16 }}>
          <Space style={{ marginBottom: 8 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {t('receivables.ledger.statement')}
            </Typography.Title>
            <Input
              aria-label={t('receivables.ledger.from')}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <Input
              aria-label={t('receivables.ledger.to')}
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <Button onClick={() => window.print()}>{t('receivables.ledger.print')}</Button>
          </Space>
          {statement.data !== undefined && (
            <>
              <div>
                {t('receivables.ledger.opening')}:{' '}
                <strong>{formatAmount(statement.data.opening)}</strong>
              </div>
              <Table<StatementLine>
                rowKey={(row) => `${row.date}-${row.kind}-${row.reference}`}
                size="small"
                pagination={false}
                dataSource={statement.data.lines}
                columns={[
                  { title: t('receivables.common.date'), render: (_, row) => formatDate(row.date) },
                  {
                    title: t('receivables.ledger.kind.invoice'),
                    render: (_, row) => t(`receivables.ledger.kind.${row.kind}`),
                  },
                  { title: t('receivables.ledger.reference'), render: (_, row) => row.reference },
                  {
                    title: t('receivables.ledger.debit'),
                    align: 'right',
                    render: (_, row) => formatAmount(row.debit),
                  },
                  {
                    title: t('receivables.ledger.creditCol'),
                    align: 'right',
                    render: (_, row) => formatAmount(row.credit),
                  },
                  {
                    title: t('receivables.ledger.running'),
                    align: 'right',
                    render: (_, row) => formatAmount(row.balance),
                  },
                ]}
              />
              <div>
                {t('receivables.ledger.closing')}:{' '}
                <strong>{formatAmount(statement.data.closing)}</strong>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
