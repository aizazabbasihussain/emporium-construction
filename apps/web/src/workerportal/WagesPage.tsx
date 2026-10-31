import { formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Descriptions, Input, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { workerPortalApi, type OwnWageLine } from './api';
import { currentMonth, isMonth, useErrorText } from './form';

const counts = [
  'presentDays',
  'halfDays',
  'paidLeaveDays',
  'offDays',
  'absentDays',
  'overtimeHours',
] as const satisfies readonly (keyof OwnWageLine)[];
const amounts = [
  'basicPay',
  'overtimePay',
  'allowances',
  'deductions',
  'advanceRecovery',
  'grossPay',
  'netPay',
] as const satisfies readonly (keyof OwnWageLine)[];

/** The worker's own wage line of a month, only once that month's wage sheet is approved. */
export function WorkerWagesPage() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [month, setMonth] = useState(currentMonth());
  const valid = isMonth(month);
  const wages = useQuery({
    queryKey: ['worker-wages', month],
    queryFn: () => workerPortalApi.wages(month),
    enabled: valid,
  });
  const line = wages.data?.line ?? null;

  return (
    <div>
      <Typography.Title level={3}>{t('workerportal.wages.title')}</Typography.Title>
      <Space style={{ marginBottom: 12 }}>
        <Input
          type="month"
          aria-label={t('workerportal.month')}
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
      </Space>
      {wages.isError && <Alert type="error" message={errorText(wages.error)} />}
      {wages.data !== undefined && line === null && (
        <Alert type="info" message={t('workerportal.wages.notApproved')} />
      )}
      {line !== null && (
        <Descriptions bordered size="small" column={1}>
          {counts.map((key) => (
            <Descriptions.Item key={key} label={t(`workerportal.wages.${key}`)}>
              {line[key]}
            </Descriptions.Item>
          ))}
          {amounts.map((key) => (
            <Descriptions.Item key={key} label={t(`workerportal.wages.${key}`)}>
              {formatAmount(line[key])}
            </Descriptions.Item>
          ))}
        </Descriptions>
      )}
    </div>
  );
}
