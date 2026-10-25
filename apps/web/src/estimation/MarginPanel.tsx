import { formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Descriptions, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { estimationApi, type EstimateLine, type Terms } from './api';

export interface MarginPanelProps {
  lines: EstimateLine[];
  terms: Terms;
}

const money = (value: string | null): string => (value === null ? '-' : formatAmount(value));

/**
 * Cost, overhead, contingency and expected margin for the lines on screen (BR-5 to BR-7). The API
 * computes every figure; this panel only shows them.
 */
export function MarginPanel({ lines, terms }: MarginPanelProps) {
  const { t } = useTranslation();
  const body = {
    ...terms,
    lines: lines.map((line) => ({
      lineKind: line.lineKind,
      quantity: line.quantity,
      rate: line.rate,
      suppliedBy: line.suppliedBy,
    })),
  };
  const preview = useQuery({
    queryKey: ['estimation', 'preview', body],
    queryFn: () => estimationApi.preview(body),
    placeholderData: (previous) => previous,
  });

  if (preview.isError) return <Alert type="error" message={t('estimation.margin.failed')} />;
  if (preview.data === undefined) return null;
  const { totals, rateMissingCount } = preview.data;
  return (
    <div aria-label={t('estimation.margin.title')}>
      {rateMissingCount > 0 && (
        <Alert
          type="warning"
          style={{ marginBottom: 8 }}
          message={t('estimation.margin.rateMissing', { count: rateMissingCount })}
        />
      )}
      <Descriptions bordered size="small" column={1} title={t('estimation.margin.title')}>
        <Descriptions.Item label={t('estimation.margin.companyCost')}>
          {money(totals.companyCost)}
        </Descriptions.Item>
        <Descriptions.Item label={t('estimation.margin.clientSupplied')}>
          {money(totals.clientSuppliedValue)}
        </Descriptions.Item>
        <Descriptions.Item label={t('estimation.margin.overhead')}>
          {money(totals.overheadAmount)}
        </Descriptions.Item>
        <Descriptions.Item label={t('estimation.margin.contingency')}>
          {money(totals.contingencyAmount)}
        </Descriptions.Item>
        <Descriptions.Item label={t('estimation.margin.totalCost')}>
          {money(totals.totalCost)}
        </Descriptions.Item>
        <Descriptions.Item label={t('estimation.margin.price')}>
          {money(totals.proposedPrice)}
        </Descriptions.Item>
        <Descriptions.Item label={t('estimation.margin.margin')}>
          {money(totals.expectedMargin)}
        </Descriptions.Item>
        <Descriptions.Item label={t('estimation.margin.marginPercent')}>
          {totals.marginPercent === null ? '-' : `${totals.marginPercent}%`}
          {totals.meetsTarget !== null && (
            <Tag color={totals.meetsTarget ? 'green' : 'orange'} style={{ marginInlineStart: 8 }}>
              {totals.meetsTarget
                ? t('estimation.margin.meetsTarget', { target: totals.targetMarginPercent })
                : t('estimation.margin.belowTarget', { target: totals.targetMarginPercent })}
            </Tag>
          )}
        </Descriptions.Item>
      </Descriptions>
    </div>
  );
}
