import { formatAmount, projectStatuses, projectsPermissions } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { projectsApi, type Project } from './api';
import { NewProjectDialog } from './NewProjectDialog';

const PAGE_SIZE = 20;

export function ProjectsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const projects = useQuery({
    queryKey: ['projects', 'list', text, status, page],
    queryFn: () =>
      projectsApi.list({
        q: text.trim() === '' ? undefined : text.trim(),
        status,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
  });

  return (
    <div>
      <Typography.Title level={3}>{t('projects.title')}</Typography.Title>
      {projects.isError && <Alert type="error" message={t('common.loadError')} />}
      <Space style={{ margin: '12px 0' }} wrap>
        <Input.Search
          aria-label={t('common.search')}
          placeholder={t('common.search')}
          allowClear
          onSearch={(value) => {
            setText(value);
            setPage(1);
          }}
        />
        <Select
          aria-label={t('projects.field.status')}
          placeholder={t('projects.field.status')}
          allowClear
          style={{ width: 200 }}
          value={status}
          onChange={(value: string | undefined) => {
            setStatus(value);
            setPage(1);
          }}
          options={projectStatuses.map((value) => ({
            value,
            label: t(`projects.status.${value}`),
          }))}
        />
        {can(projectsPermissions.create) && (
          <Button type="primary" onClick={() => setCreating(true)}>
            {t('projects.new')}
          </Button>
        )}
      </Space>
      <Table<Project>
        rowKey="id"
        loading={projects.isLoading}
        dataSource={projects.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: projects.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          {
            title: t('projects.field.code'),
            render: (_, row) => <Link to={`/projects/${row.id}`}>{row.code}</Link>,
          },
          { title: t('projects.field.name'), dataIndex: 'name' },
          {
            title: t('projects.field.status'),
            render: (_, row) => <Tag>{t(`projects.status.${row.status}`)}</Tag>,
          },
          {
            title: t('projects.field.progress'),
            align: 'right',
            render: (_, row) => `${row.progressPercent}%`,
          },
          {
            title: t('projects.field.contractValue'),
            align: 'right',
            render: (_, row) => formatAmount(row.originalContractValue),
          },
        ]}
      />
      {creating && (
        <NewProjectDialog
          open
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            void navigate(`/projects/${project.id}`);
          }}
        />
      )}
    </div>
  );
}
