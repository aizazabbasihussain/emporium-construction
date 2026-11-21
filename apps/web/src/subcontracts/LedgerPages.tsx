import { formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Select, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { subcontractsApi, type Ledger, type Statement } from './api';
import { useSubcontractors } from './hooks';

const right = 'right' as const;

/** The work order ledger: contract, certified, billed and paid (spec section 5). */
export function WorkOrderLedgerPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const ledger = useQuery({
    queryKey: ['subcontracts', 'ledger', id],
    queryFn: () => subcontractsApi.ledger(id),
  });
  if (ledger.isError) return <Alert type="error" message={t('common.loadError')} />;
  const data: Ledger | undefined = ledger.data;
  if (data === undefined) return null;
  const rows = [
    ['contract', data.contract],
    ['certified', data.certified],
    ['deductions', data.deductions],
    ['billed', data.billed],
    ['paid', data.paid],
    ['committed', data.committed],
  ] as const;
  return (
    <div>
      <Typography.Title level={3}>
        {t('subcontracts.ledger.title')} · {data.number}
      </Typography.Title>
      <Link to={`/subcontracts/work-orders/${id}`}>{t('subcontracts.ledger.back')}</Link>
      <table style={{ margin: '12px 0' }}>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key}>
              <td>{t(`subcontracts.ledger.${key}`)}</td>
              <td style={{ textAlign: right }}>{formatAmount(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Table
        rowKey="certificateId"
        size="small"
        pagination={false}
        dataSource={data.certificates}
        locale={{ emptyText: t('subcontracts.certificates.none') }}
        columns={[
          {
            title: t('subcontracts.certificates.number'),
            render: (_, row) => (
              <Link to={`/subcontracts/certificates/${row.certificateId}`}>{row.number}</Link>
            ),
          },
          {
            title: t('subcontracts.common.status'),
            render: (_, row) => <Tag>{t(`subcontracts.certificateStatus.${row.status}`)}</Tag>,
          },
          {
            title: t('subcontracts.certificates.gross'),
            align: right,
            render: (_, row) => formatAmount(row.gross),
          },
          {
            title: t('subcontracts.certificates.deductions'),
            align: right,
            render: (_, row) => formatAmount(row.deductions),
          },
          {
            title: t('subcontracts.certificates.net'),
            align: right,
            render: (_, row) => formatAmount(row.net),
          },
          {
            title: t('subcontracts.ledger.paid'),
            align: right,
            render: (_, row) => formatAmount(row.paid),
          },
        ]}
      />
    </div>
  );
}

/** What a subcontractor has been ordered, certified, billed and paid (spec section 5). */
export function StatementPage() {
  const { t } = useTranslation();
  const { options } = useSubcontractors();
  const [partyId, setPartyId] = useState('');
  const statement = useQuery({
    queryKey: ['subcontracts', 'statement', partyId],
    queryFn: () => subcontractsApi.statement(partyId),
    enabled: partyId !== '',
  });
  const data: Statement | undefined = statement.data;
  return (
    <div>
      <Typography.Title level={3}>{t('subcontracts.statement.title')}</Typography.Title>
      <Select
        aria-label={t('subcontracts.common.subcontractor')}
        placeholder={t('subcontracts.common.subcontractor')}
        showSearch
        optionFilterProp="label"
        style={{ width: 320, marginBottom: 12 }}
        value={partyId === '' ? undefined : partyId}
        onChange={setPartyId}
        options={options}
      />
      {statement.isError && <Alert type="error" message={t('common.loadError')} />}
      {data !== undefined && (
        <Table
          rowKey="workOrderId"
          size="small"
          pagination={false}
          dataSource={data.orders}
          locale={{ emptyText: t('subcontracts.orders.none') }}
          columns={[
            {
              title: t('subcontracts.orders.number'),
              render: (_, row) => (
                <Link to={`/subcontracts/work-orders/${row.workOrderId}`}>{row.number}</Link>
              ),
            },
            { title: t('subcontracts.orders.titleField'), dataIndex: 'title' },
            {
              title: t('subcontracts.common.status'),
              render: (_, row) => <Tag>{t(`subcontracts.status.${row.status}`)}</Tag>,
            },
            {
              title: t('subcontracts.ledger.contract'),
              align: right,
              render: (_, row) => formatAmount(row.contract),
            },
            {
              title: t('subcontracts.ledger.certified'),
              align: right,
              render: (_, row) => formatAmount(row.certified),
            },
            {
              title: t('subcontracts.ledger.deductions'),
              align: right,
              render: (_, row) => formatAmount(row.deductions),
            },
            {
              title: t('subcontracts.ledger.billed'),
              align: right,
              render: (_, row) => formatAmount(row.billed),
            },
            {
              title: t('subcontracts.ledger.paid'),
              align: right,
              render: (_, row) => formatAmount(row.paid),
            },
          ]}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={3}>
                {t('subcontracts.statement.totals')}
              </Table.Summary.Cell>
              {(['contract', 'certified', 'deductions', 'billed', 'paid'] as const).map(
                (key, i) => (
                  <Table.Summary.Cell key={key} index={i + 3} align={right}>
                    {formatAmount(data.totals[key])}
                  </Table.Summary.Cell>
                ),
              )}
            </Table.Summary.Row>
          )}
        />
      )}
    </div>
  );
}
