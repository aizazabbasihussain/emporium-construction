import { formatAmount } from '@emporium/shared';
import { Descriptions, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import type { MarginPanelData } from './api';

/** Internal cost and margin. The API sends it only to holders of quotations.margin.read (spec section 5). */
export function MarginPanel({ margin }: { margin: MarginPanelData }) {
  const { t } = useTranslation();
  return (
    <Descriptions bordered size="small" column={1} title={t('quotations.margin.title')}>
      <Descriptions.Item label={t('quotations.margin.totalCost')}>
        {formatAmount(margin.totalCost)}
      </Descriptions.Item>
      <Descriptions.Item label={t('quotations.margin.marginAmount')}>
        {formatAmount(margin.marginAmount)}
      </Descriptions.Item>
      <Descriptions.Item label={t('quotations.margin.marginPercent')}>
        {margin.marginPercent}%
        <Tag color={margin.belowFloor ? 'orange' : 'green'} style={{ marginInlineStart: 8 }}>
          {t(margin.belowFloor ? 'quotations.margin.belowFloor' : 'quotations.margin.aboveFloor')}
        </Tag>
      </Descriptions.Item>
      <Descriptions.Item label={t('quotations.margin.floor')}>
        {margin.floorPercent}%
      </Descriptions.Item>
    </Descriptions>
  );
}
