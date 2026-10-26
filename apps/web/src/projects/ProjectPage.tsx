import {
  formatAmount,
  projectStatuses,
  projectsPermissions as perm,
  taskStatuses,
  type ProjectStatus,
  type TaskStatus,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Descriptions,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { useLineReferences } from '../estimation/lists';
import {
  projectsApi,
  type BudgetFlag,
  type BudgetLineInput,
  type CostEntry,
  type SummaryLine,
  type Task,
} from './api';
import { BudgetEditor } from './BudgetEditor';

const FLAG_COLOUR: Record<BudgetFlag, string> = {
  ok: 'green',
  warning: 'orange',
  overspent: 'red',
};

export function ProjectPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const { id = '' } = useParams();
  const { costCodeOptions } = useLineReferences();
  const [error, setError] = useState<string | null>(null);
  const [newTask, setNewTask] = useState('');

  const project = useQuery({ queryKey: ['projects', id], queryFn: () => projectsApi.get(id) });
  const summary = useQuery({
    queryKey: ['projects', id, 'summary'],
    queryFn: () => projectsApi.summary(id),
    enabled: can(perm.costRead),
  });
  const budget = useQuery({
    queryKey: ['projects', id, 'budget'],
    queryFn: () => projectsApi.budget(id),
  });
  const tasks = useQuery({
    queryKey: ['projects', id, 'tasks'],
    queryFn: () => projectsApi.tasks(id),
  });
  const entries = useQuery({
    queryKey: ['projects', id, 'entries'],
    queryFn: () => projectsApi.entries(id, { limit: 100 }),
    enabled: can(perm.costRead),
  });

  const failed = (cause: unknown) =>
    setError(
      cause instanceof ApiError
        ? t(`projects.errors.${cause.code}`, { defaultValue: cause.message })
        : t('common.saveError'),
    );
  const refresh = () => {
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ['projects', id] });
  };

  const changeStatus = useMutation({
    mutationFn: (status: ProjectStatus) =>
      projectsApi.setStatus(id, status, project.data?.version ?? 0),
    onSuccess: refresh,
    onError: failed,
  });
  const saveBudget = useMutation({
    mutationFn: (lines: BudgetLineInput[]) =>
      projectsApi.saveBudget(id, budget.data?.projectVersion ?? 0, lines),
    onSuccess: refresh,
    onError: failed,
  });
  const addTask = useMutation({
    mutationFn: () => projectsApi.createTask(id, { name: newTask.trim() }),
    onSuccess: () => {
      setNewTask('');
      refresh();
    },
    onError: failed,
  });
  const moveTask = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: TaskStatus }) =>
      projectsApi.updateTask(id, task.id, { version: task.version, status }),
    onSuccess: refresh,
    onError: failed,
  });

  const data = project.data;
  if (project.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (data === undefined) return null;
  const codeLabel = (codeId: string) =>
    costCodeOptions.find((option) => option.value === codeId)?.label ?? codeId;

  return (
    <div>
      <Link to="/projects">{t('projects.back')}</Link>
      <Typography.Title level={3}>
        {data.code} {data.name} <Tag>{t(`projects.status.${data.status}`)}</Tag>
      </Typography.Title>
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {can(perm.status) && (
        <Select
          aria-label={t('projects.changeStatus')}
          placeholder={t('projects.changeStatus')}
          style={{ width: 220, marginBottom: 12 }}
          value={undefined}
          onChange={(status: ProjectStatus) => changeStatus.mutate(status)}
          options={projectStatuses
            .filter((status) => status !== data.status)
            .map((status) => ({ value: status, label: t(`projects.status.${status}`) }))}
        />
      )}
      <Tabs
        items={[
          {
            key: 'overview',
            label: t('projects.tabs.overview'),
            children: (
              <div>
                <Descriptions column={2} bordered size="small">
                  <Descriptions.Item label={t('projects.field.contractValue')}>
                    {formatAmount(data.originalContractValue)}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('projects.field.progress')}>
                    {data.progressPercent}%
                  </Descriptions.Item>
                  <Descriptions.Item label={t('projects.field.sector')}>
                    {t(`projects.sector.${data.sector}`)}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('projects.field.siteAddress')}>
                    {data.siteAddress ?? ''}
                  </Descriptions.Item>
                </Descriptions>
                {summary.data !== undefined && (
                  <Table<SummaryLine>
                    style={{ marginTop: 16 }}
                    title={() => t('projects.summary.title')}
                    rowKey="costCodeId"
                    pagination={false}
                    dataSource={summary.data.lines}
                    columns={[
                      {
                        title: t('projects.summary.costCode'),
                        render: (_, row) => codeLabel(row.costCodeId),
                      },
                      {
                        title: t('projects.summary.budget'),
                        align: 'right',
                        render: (_, row) => formatAmount(row.budget ?? '0'),
                      },
                      {
                        title: t('projects.summary.committed'),
                        align: 'right',
                        render: (_, row) => formatAmount(row.committed),
                      },
                      {
                        title: t('projects.summary.approved'),
                        align: 'right',
                        render: (_, row) => formatAmount(row.approved),
                      },
                      {
                        title: t('projects.summary.posted'),
                        align: 'right',
                        render: (_, row) => formatAmount(row.posted),
                      },
                      {
                        title: t('projects.summary.variance'),
                        align: 'right',
                        render: (_, row) => (
                          <Tag color={FLAG_COLOUR[row.flag ?? 'ok']}>
                            {formatAmount(row.variance ?? '0')}
                          </Tag>
                        ),
                      },
                    ]}
                    summary={() => (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0}>
                          {t('projects.summary.total')}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={1} align="right">
                          {formatAmount(summary.data.budget ?? '0')}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={2} align="right">
                          {formatAmount(summary.data.totals.committed)}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={3} align="right">
                          {formatAmount(summary.data.totals.approved)}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={4} align="right">
                          {formatAmount(summary.data.totals.posted)}
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={5} align="right">
                          <Tag color={FLAG_COLOUR[summary.data.flag ?? 'ok']}>
                            {t(`projects.summary.flag.${summary.data.flag ?? 'ok'}`)}
                          </Tag>
                        </Table.Summary.Cell>
                      </Table.Summary.Row>
                    )}
                  />
                )}
              </div>
            ),
          },
          {
            key: 'budget',
            label: t('projects.tabs.budget'),
            children: budget.data !== undefined && (
              <BudgetEditor
                key={budget.data.projectVersion}
                lines={budget.data.lines}
                costCodeOptions={costCodeOptions}
                canEdit={can(perm.budgetManage)}
                saving={saveBudget.isPending}
                error={error}
                onSave={(lines) => saveBudget.mutate(lines)}
              />
            ),
          },
          {
            key: 'tasks',
            label: t('projects.tabs.tasks'),
            children: (
              <div>
                {can(perm.taskManage) && (
                  <Space style={{ marginBottom: 12 }}>
                    <Input
                      aria-label={t('projects.tasks.name')}
                      placeholder={t('projects.tasks.name')}
                      value={newTask}
                      onChange={(event) => setNewTask(event.target.value)}
                    />
                    <Button
                      type="primary"
                      disabled={newTask.trim() === ''}
                      onClick={() => addTask.mutate()}
                    >
                      {t('projects.tasks.add')}
                    </Button>
                  </Space>
                )}
                <Table<Task>
                  rowKey="id"
                  pagination={false}
                  locale={{ emptyText: t('projects.tasks.empty') }}
                  dataSource={tasks.data ?? []}
                  columns={[
                    { title: t('projects.tasks.name'), dataIndex: 'name' },
                    {
                      title: t('projects.tasks.percent'),
                      align: 'right',
                      render: (_, row) => `${row.percentComplete}%`,
                    },
                    {
                      title: t('projects.field.status'),
                      render: (_, row) => (
                        <Select
                          aria-label={`${t('projects.field.status')} ${row.name}`}
                          style={{ width: 140 }}
                          disabled={!can(perm.taskManage)}
                          value={row.status}
                          onChange={(status: TaskStatus) => moveTask.mutate({ task: row, status })}
                          options={taskStatuses.map((status) => ({
                            value: status,
                            label: t(`projects.tasks.status.${status}`),
                          }))}
                        />
                      ),
                    },
                  ]}
                />
              </div>
            ),
          },
          {
            key: 'costs',
            label: t('projects.tabs.costs'),
            children: (
              <Table<CostEntry>
                rowKey="id"
                pagination={false}
                locale={{ emptyText: t('projects.costs.empty') }}
                dataSource={entries.data?.items ?? []}
                columns={[
                  { title: t('projects.costs.date'), dataIndex: 'entryDate' },
                  {
                    title: t('projects.summary.costCode'),
                    render: (_, row) => codeLabel(row.costCodeId),
                  },
                  {
                    title: t('projects.costs.source'),
                    render: (_, row) => `${row.sourceModule} / ${row.sourceDocType}`,
                  },
                  { title: t('projects.costs.description'), dataIndex: 'description' },
                  {
                    title: t('projects.field.status'),
                    render: (_, row) => <Tag>{t(`projects.costStatus.${row.status}`)}</Tag>,
                  },
                  {
                    title: t('projects.costs.amount'),
                    align: 'right',
                    render: (_, row) => formatAmount(row.amount),
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
