import { formatDate } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, List, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { workerPortalApi } from './api';
import { currentMonth, isMonth, useErrorText } from './form';

/** The worker's own approved attendance of a month: read-only, one line per day. */
export function WorkerAttendancePage() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [month, setMonth] = useState(currentMonth());
  const valid = isMonth(month);
  const days = useQuery({
    queryKey: ['worker-attendance', month],
    queryFn: () => workerPortalApi.attendance(month),
    enabled: valid,
  });

  return (
    <div>
      <Typography.Title level={3}>{t('workerportal.attendance.title')}</Typography.Title>
      <Space style={{ marginBottom: 12 }}>
        <Input
          type="month"
          aria-label={t('workerportal.month')}
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
      </Space>
      {days.isError && <Alert type="error" message={errorText(days.error)} />}
      <List
        bordered
        loading={days.isLoading}
        locale={{ emptyText: t('workerportal.attendance.empty') }}
        dataSource={days.data?.days ?? []}
        renderItem={(day) => (
          <List.Item>
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{formatDate(day.date)}</Typography.Text>
              <Typography.Text>{t(`attendance.status.${day.status}`)}</Typography.Text>
            </Space>
            {Number(day.overtimeHours) > 0 && (
              <Typography.Text type="secondary">
                {t('workerportal.attendance.overtime')}: {day.overtimeHours}
              </Typography.Text>
            )}
          </List.Item>
        )}
      />
    </div>
  );
}
