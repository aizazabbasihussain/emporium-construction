import { formatDate } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dprApi, type MissingReport } from './api';
import { karachiToday } from './form';

/** Projects with a supervisor and no submitted report for a day (BR-6). */
export function MissingReportsPage() {
  const { t } = useTranslation();
  const [date, setDate] = useState(karachiToday());
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const missing = useQuery({
    queryKey: ['dpr-missing', date],
    queryFn: () => dprApi.missing(date),
    enabled: valid,
  });

  return (
    <div>
      <Typography.Title level={3}>{t('dpr.missingTitle')}</Typography.Title>
      <Space style={{ marginBottom: 12 }}>
        <Input
          type="date"
          aria-label={t('dpr.missingDate')}
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </Space>
      {missing.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<MissingReport>
        rowKey="projectId"
        size="small"
        scroll={{ x: 'max-content' }}
        loading={missing.isLoading}
        locale={{ emptyText: t('dpr.missingEmpty') }}
        dataSource={missing.data ?? []}
        columns={[
          { title: t('dpr.field.project'), render: (_, row) => `${row.code} ${row.name}` },
          { title: t('dpr.field.date'), render: () => (valid ? formatDate(date) : '') },
          {
            title: t('dpr.field.supervisors'),
            align: 'right',
            render: (_, row) => row.supervisorIds.length,
          },
        ]}
      />
    </div>
  );
}
