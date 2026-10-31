import { formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, List, Statistic, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { workerPortalApi } from './api';
import { useErrorText } from './form';

/** The worker's own advance balance and what was recovered from their wages. */
export function WorkerAdvancesPage() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const advances = useQuery({ queryKey: ['worker-advances'], queryFn: workerPortalApi.advances });

  return (
    <div>
      <Typography.Title level={3}>{t('workerportal.advances.title')}</Typography.Title>
      {advances.isError && <Alert type="error" message={errorText(advances.error)} />}
      {advances.data !== undefined && (
        <>
          <Statistic
            title={t('workerportal.advances.balance')}
            value={formatAmount(advances.data.balance)}
            style={{ marginBottom: 16 }}
          />
          <Typography.Title level={5}>{t('workerportal.advances.recoveries')}</Typography.Title>
          <List
            bordered
            locale={{ emptyText: t('workerportal.advances.empty') }}
            dataSource={advances.data.recoveries}
            renderItem={(item) => (
              <List.Item>
                <Typography.Text>{item.month}</Typography.Text>
                <Typography.Text strong>{formatAmount(item.amount)}</Typography.Text>
              </List.Item>
            )}
          />
        </>
      )}
    </div>
  );
}
