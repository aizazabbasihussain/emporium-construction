import { formatDate } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { attendanceApi, type MissingSheet } from './api';
import { karachiToday } from './form';

const daysAgo = (days: number): string => {
  const base = new Date(`${karachiToday()}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
};

/** Working days on which a team with members has no attendance sheet at all (BR-9). */
export function MissingPage() {
  const { t } = useTranslation();
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(karachiToday());
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const missing = useQuery({
    queryKey: ['attendance-missing', from, to],
    queryFn: () => attendanceApi.missing(from, to),
    enabled: valid,
  });

  return (
    <div>
      <Typography.Title level={3}>{t('attendance.missing.title')}</Typography.Title>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          type="date"
          aria-label={t('attendance.sheets.from')}
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Input
          type="date"
          aria-label={t('attendance.sheets.to')}
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </Space>
      {missing.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<MissingSheet>
        size="small"
        rowKey={(item) => `${item.teamId}|${item.date}`}
        pagination={false}
        dataSource={missing.data ?? []}
        locale={{ emptyText: t('attendance.missing.empty') }}
        columns={[
          { title: t('attendance.grid.date'), render: (_, m) => formatDate(m.date) },
          { title: t('attendance.grid.team'), render: (_, m) => `${m.teamCode} ${m.teamName}` },
          {
            title: '',
            render: (_, m) => (
              <Link to={`/attendance/grid?team=${m.teamId}&date=${m.date}`}>
                {t('attendance.missing.fill')}
              </Link>
            ),
          },
        ]}
      />
    </div>
  );
}
