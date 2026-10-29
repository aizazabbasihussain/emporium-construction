import { formatAmount, formatDate, sheetStatuses } from '@emporium/shared';
import type { SheetStatus } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { attendanceApi, type SheetHeader } from './api';
import { karachiToday } from './form';

const weekAgo = (): string => {
  const base = new Date(`${karachiToday()}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - 7);
  return base.toISOString().slice(0, 10);
};

/** The sheets of the teams the caller can see, newest first; the manager approves from the inbox. */
export function SheetsPage() {
  const { t } = useTranslation();
  const [from, setFrom] = useState(weekAgo());
  const [to, setTo] = useState(karachiToday());
  const [status, setStatus] = useState<SheetStatus | ''>('');

  const teams = useQuery({ queryKey: ['attendance-teams'], queryFn: attendanceApi.teams });
  const list = useQuery({
    queryKey: ['attendance-sheets', from, to, status],
    queryFn: () => attendanceApi.sheets({ from, to, ...(status === '' ? {} : { status }) }),
  });
  const teamName = (id: string): string => {
    const found = teams.data?.find((team) => team.id === id);
    return found === undefined ? id : `${found.code} ${found.name}`;
  };

  return (
    <div>
      <Typography.Title level={3}>{t('attendance.sheets.title')}</Typography.Title>
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
        <select
          aria-label={t('attendance.sheets.status')}
          style={{ padding: '4px 6px' }}
          value={status}
          onChange={(event) => setStatus(event.target.value as SheetStatus | '')}
        >
          <option value="">{t('attendance.sheets.allStatuses')}</option>
          {sheetStatuses.map((value) => (
            <option key={value} value={value}>
              {t(`attendance.sheetStatus.${value}`)}
            </option>
          ))}
        </select>
      </Space>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<SheetHeader>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={list.data?.items ?? []}
        locale={{ emptyText: t('attendance.sheets.empty') }}
        columns={[
          { title: t('attendance.grid.date'), render: (_, s) => formatDate(s.sheetDate) },
          { title: t('attendance.grid.team'), render: (_, s) => teamName(s.teamId) },
          {
            title: t('attendance.sheets.status'),
            render: (_, s) => <Tag>{t(`attendance.sheetStatus.${s.status}`)}</Tag>,
          },
          {
            // The API sends no cost to a supervisor, so the column stays empty for them.
            title: t('attendance.sheets.total'),
            render: (_, s) => (s.total === null ? '' : formatAmount(s.total)),
          },
          {
            title: '',
            render: (_, s) => (
              <Link to={`/attendance/grid?team=${s.teamId}&date=${s.sheetDate}`}>
                {t('attendance.sheets.open')}
              </Link>
            ),
          },
        ]}
      />
    </div>
  );
}
