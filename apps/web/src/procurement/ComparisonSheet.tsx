import { formatAmount } from '@emporium/shared';
import { Alert, Button, Input, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Rfq } from './api';

export interface ComparisonSheetProps {
  rfq: Rfq;
  vendorName: (vendorId: string) => string;
  lineLabel: (requisitionLineId: string) => string;
  readOnly?: boolean;
  /** `reason` is given when the chosen quote is not the lowest rate for the line (BR-2). */
  onSelect: (requisitionLineId: string, quoteId: string, reason?: string) => void;
}

/** The comparison sheet: rates ranked per line, totals ranked per quote, and the choice per line. */
export function ComparisonSheet({
  rfq,
  vendorName,
  lineLabel,
  readOnly = false,
  onSelect,
}: ComparisonSheetProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<{ lineId: string; quoteId: string } | null>(null);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState(false);

  const chosen = (lineId: string) => rfq.selections.find((s) => s.requisitionLineId === lineId);

  const pick = (lineId: string, quoteId: string, rank: number) => {
    if (rank === 1) {
      setPending(null);
      onSelect(lineId, quoteId);
      return;
    }
    setProblem(false);
    setReason('');
    setPending({ lineId, quoteId });
  };

  const confirm = () => {
    if (pending === null) return;
    if (reason.trim() === '') {
      setProblem(true);
      return;
    }
    onSelect(pending.lineId, pending.quoteId, reason.trim());
    setPending(null);
  };

  return (
    <div>
      <Table
        rowKey="requisitionLineId"
        size="small"
        pagination={false}
        dataSource={rfq.comparison.lines}
        columns={[
          {
            title: t('procurement.comparison.line'),
            render: (_, row) =>
              `${row.lineNo}. ${lineLabel(row.requisitionLineId)} × ${row.quantity}`,
          },
          ...rfq.quotes.map((quote) => ({
            title: vendorName(quote.vendorId),
            render: (_: unknown, row: Rfq['comparison']['lines'][number]) => {
              const entry = row.ranking.find((r) => r.quoteId === quote.id);
              if (entry === undefined) return t('procurement.comparison.notQuoted');
              const selected = chosen(row.requisitionLineId)?.quoteId === quote.id;
              return (
                <Space wrap>
                  <span>{formatAmount(entry.rate)}</span>
                  {entry.rank === 1 ? (
                    <Tag color="green">{t('procurement.comparison.lowest')}</Tag>
                  ) : null}
                  {selected ? (
                    <Tag color="blue">{t('procurement.comparison.selected')}</Tag>
                  ) : readOnly ? null : (
                    <Button
                      size="small"
                      aria-label={`${t('procurement.comparison.select')} ${vendorName(quote.vendorId)} ${row.lineNo}`}
                      onClick={() => pick(row.requisitionLineId, quote.id, entry.rank)}
                    >
                      {t('procurement.comparison.select')}
                    </Button>
                  )}
                </Space>
              );
            },
          })),
        ]}
      />
      <Table
        style={{ marginTop: 16 }}
        rowKey="quoteId"
        size="small"
        pagination={false}
        dataSource={rfq.comparison.totals}
        columns={[
          { title: t('procurement.comparison.rank'), dataIndex: 'rank' },
          {
            title: t('procurement.comparison.vendor'),
            render: (_, row) => vendorName(row.vendorId),
          },
          { title: t('procurement.comparison.total'), render: (_, row) => formatAmount(row.total) },
          {
            title: '',
            render: (_, row) =>
              row.complete ? null : <Tag color="orange">{t('procurement.comparison.partial')}</Tag>,
          },
        ]}
      />
      {pending === null ? null : (
        <div style={{ marginTop: 16 }}>
          <Alert type="warning" showIcon message={t('procurement.comparison.reasonNeeded')} />
          <Space style={{ marginTop: 8 }}>
            <Input
              aria-label={t('procurement.comparison.reason')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              style={{ width: 320 }}
            />
            <Button type="primary" onClick={confirm}>
              {t('procurement.comparison.confirm')}
            </Button>
            <Button onClick={() => setPending(null)}>{t('common.cancel')}</Button>
          </Space>
          {problem ? (
            <Alert type="error" showIcon message={t('procurement.comparison.reasonRequired')} />
          ) : null}
        </div>
      )}
    </div>
  );
}
