import { dprPermissions as perm, dprStatuses, formatDate, type DprStatus } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { projectsApi } from '../projects/api';
import { dprApi, type ReportHeader } from './api';

/** The reports of the projects the caller can see, newest first. */
export function ReportsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<DprStatus | undefined>(undefined);
  const [mine, setMine] = useState(false);

  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectsApi.list({ limit: 200 }),
  });
  const list = useQuery({
    queryKey: ['dpr-reports', projectId, status, mine],
    queryFn: () =>
      dprApi.reports({
        ...(projectId === undefined ? {} : { projectId }),
        ...(status === undefined ? {} : { status }),
        ...(mine ? { mine: true } : {}),
      }),
  });
  const projectName = (id: string): string => {
    const found = projects.data?.items.find((p) => p.id === id);
    return found === undefined ? id : `${found.code} ${found.name}`;
  };

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('dpr.title')}
        </Typography.Title>
        {can(perm.reportCreate) && (
          <Link to="/dpr/reports/new">
            <Button type="primary">{t('dpr.new')}</Button>
          </Link>
        )}
      </Space>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          allowClear
          style={{ minWidth: 240 }}
          aria-label={t('dpr.field.project')}
          placeholder={t('dpr.allProjects')}
          value={projectId}
          onChange={(value: string | undefined) => setProjectId(value)}
          options={(projects.data?.items ?? []).map((p) => ({
            value: p.id,
            label: `${p.code} ${p.name}`,
          }))}
        />
        <Select
          allowClear
          style={{ minWidth: 180 }}
          aria-label={t('dpr.field.status')}
          placeholder={t('dpr.allStatuses')}
          value={status}
          onChange={(value: DprStatus | undefined) => setStatus(value)}
          options={dprStatuses.map((s) => ({ value: s, label: t(`dpr.status.${s}`) }))}
        />
        <Checkbox checked={mine} onChange={(event) => setMine(event.target.checked)}>
          {t('dpr.mineOnly')}
        </Checkbox>
      </Space>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<ReportHeader>
        rowKey="id"
        size="small"
        scroll={{ x: 'max-content' }}
        loading={list.isLoading}
        locale={{ emptyText: t('dpr.empty') }}
        dataSource={list.data?.items ?? []}
        columns={[
          {
            title: t('dpr.field.date'),
            render: (_, report) => (
              <Link to={`/dpr/reports/${report.id}`}>{formatDate(report.reportDate)}</Link>
            ),
          },
          { title: t('dpr.field.project'), render: (_, report) => projectName(report.projectId) },
          {
            title: t('dpr.field.weather'),
            render: (_, report) => t(`dpr.weather.${report.weather}`),
          },
          {
            title: t('dpr.field.status'),
            render: (_, report) => <Tag>{t(`dpr.status.${report.status}`)}</Tag>,
          },
        ]}
      />
    </div>
  );
}
