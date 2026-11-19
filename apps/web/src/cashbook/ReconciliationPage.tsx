import { cashbookPermissions as perm, formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { cashbookApi, type ReconciliationDetail, type StatementLine } from './api';

type Matches = { lineId: string; transactionId: string | null }[];

/** The reconciliation workspace (BR-8): import, match, see the difference, complete. */
export function ReconciliationPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');
  const query = useQuery({
    queryKey: ['cashbook', 'reconciliation', id],
    queryFn: () => cashbookApi.reconciliation(id),
  });
  const accept = (data: ReconciliationDetail) =>
    queryClient.setQueryData(['cashbook', 'reconciliation', id], data);
  const importing = useMutation({
    mutationFn: () => cashbookApi.importStatement(id, csv),
    onSuccess: (data) => {
      accept(data);
      setCsv('');
    },
  });
  const matching = useMutation({
    mutationFn: (matches: Matches) => cashbookApi.match(id, matches),
    onSuccess: accept,
  });
  const completing = useMutation({
    mutationFn: (version: number) => cashbookApi.complete(id, version),
    onSuccess: (data) => {
      accept(data);
      void queryClient.invalidateQueries({ queryKey: ['cashbook', 'reconciliations'] });
    },
  });
  const reopening = useMutation({ mutationFn: () => cashbookApi.reopen(id), onSuccess: accept });

  const data = query.data;
  if (data === undefined) {
    return query.isError ? <Alert type="error" message={t('common.loadError')} /> : null;
  }
  const editable = data.status === 'draft' && can(perm.reconcile);
  const zero = Number(data.figures.difference) === 0;
  const txnLabel = (txnId: string) => {
    const txn = data.candidates.find((c) => c.id === txnId);
    return txn === undefined
      ? txnId
      : `${txn.number} · ${formatDate(txn.txnDate)} · ${formatAmount(txn.amount)}`;
  };
  const optionsFor = (line: StatementLine) =>
    data.candidates
      .filter(
        (c) =>
          c.direction === (Number(line.credit) > 0 ? 'in' : 'out') &&
          Number(c.amount) === Number(line.credit) + Number(line.debit),
      )
      .map((c) => ({ value: c.id, label: txnLabel(c.id) }));

  return (
    <div>
      <Typography.Title level={3}>
        {t('cashbook.recon.workspace', {
          from: formatDate(data.statementFrom),
          to: formatDate(data.statementTo),
        })}
      </Typography.Title>
      <Tag>{t(`cashbook.recon.state.${data.status}`)}</Tag>
      <Descriptions bordered size="small" column={2} style={{ margin: '12px 0' }}>
        <Descriptions.Item label={t('cashbook.recon.closing')}>
          {formatAmount(data.statementClosingBalance)}
        </Descriptions.Item>
        <Descriptions.Item label={t('cashbook.recon.bookBalance')}>
          {formatAmount(data.figures.bookBalance)}
        </Descriptions.Item>
        <Descriptions.Item label={t('cashbook.recon.bookUnreconciled')}>
          {formatAmount(data.figures.bookUnreconciled)}
        </Descriptions.Item>
        <Descriptions.Item label={t('cashbook.recon.statementUnreconciled')}>
          {formatAmount(data.figures.statementUnreconciled)}
        </Descriptions.Item>
        <Descriptions.Item label={t('cashbook.recon.expected')}>
          {formatAmount(data.figures.expectedClosing)}
        </Descriptions.Item>
        <Descriptions.Item label={t('cashbook.recon.difference')}>
          <span style={{ color: zero ? 'green' : 'crimson' }}>
            {formatAmount(data.figures.difference)}
          </span>
        </Descriptions.Item>
      </Descriptions>

      {editable && (
        <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
          <Input.TextArea
            aria-label={t('cashbook.recon.csv')}
            placeholder={t('cashbook.recon.csvHint')}
            rows={4}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
          <Space>
            <Button
              disabled={csv.trim() === ''}
              loading={importing.isPending}
              onClick={() => importing.mutate()}
            >
              {t('cashbook.recon.import')}
            </Button>
            <Button
              disabled={data.suggestions.length === 0}
              onClick={() =>
                matching.mutate(
                  data.suggestions.map((s) => ({
                    lineId: s.lineId,
                    transactionId: s.transactionId,
                  })),
                )
              }
            >
              {t('cashbook.recon.acceptSuggestions', { count: data.suggestions.length })}
            </Button>
          </Space>
        </Space>
      )}

      <Table<StatementLine>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('cashbook.recon.noLines') }}
        dataSource={data.lines}
        columns={[
          { title: t('cashbook.txn.date'), render: (_, row) => formatDate(row.lineDate) },
          { title: t('cashbook.txn.description'), dataIndex: 'description' },
          {
            title: t('cashbook.recon.debit'),
            align: 'right',
            render: (_, row) => (Number(row.debit) > 0 ? formatAmount(row.debit) : ''),
          },
          {
            title: t('cashbook.recon.credit'),
            align: 'right',
            render: (_, row) => (Number(row.credit) > 0 ? formatAmount(row.credit) : ''),
          },
          {
            title: t('cashbook.recon.matchedTo'),
            render: (_, row) =>
              editable ? (
                <Select
                  allowClear
                  aria-label={`${t('cashbook.recon.matchedTo')} ${row.lineNo}`}
                  style={{ width: 300 }}
                  value={row.matchedTransactionId ?? undefined}
                  onChange={(value: string | undefined) =>
                    matching.mutate([{ lineId: row.id, transactionId: value ?? null }])
                  }
                  options={[
                    ...optionsFor(row),
                    ...(row.matchedTransactionId === null
                      ? []
                      : [
                          {
                            value: row.matchedTransactionId,
                            label: txnLabel(row.matchedTransactionId),
                          },
                        ]),
                  ]}
                />
              ) : row.matchedTransactionId === null ? (
                t('cashbook.recon.unmatched')
              ) : (
                t('cashbook.recon.matched')
              ),
          },
        ]}
      />

      <Space style={{ marginTop: 12 }}>
        {editable && (
          <Button
            type="primary"
            disabled={!zero}
            loading={completing.isPending}
            onClick={() => completing.mutate(data.version)}
          >
            {t('cashbook.recon.complete')}
          </Button>
        )}
        {data.status === 'completed' && can(perm.reconcile) && (
          <Button loading={reopening.isPending} onClick={() => reopening.mutate()}>
            {t('cashbook.recon.reopen')}
          </Button>
        )}
      </Space>
      {editable && !zero && (
        <Alert
          style={{ marginTop: 8 }}
          type="warning"
          message={t('cashbook.recon.differenceNote', {
            difference: formatAmount(data.figures.difference),
          })}
        />
      )}
    </div>
  );
}
