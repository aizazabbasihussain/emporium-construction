import {
  formatAmount,
  formatDate,
  reportCodes,
  reportPermission,
  type ReportCode,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Select, Space, Statistic, Table, Typography } from 'antd';
import type { TablePaginationConfig } from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { RequirePermission } from '../shell/guards';
import { NotFoundPage } from '../shell/ErrorPages';
import { projectsApi } from '../projects/api';
import {
  reportsApi,
  type Cell,
  type Column,
  type ReportFilter,
  type Row,
  type SavedFilter,
  type Section,
} from './api';

const PAGE_SIZE = 50;

type FilterKey = 'projectId' | 'ownership' | 'from' | 'to' | 'overdueOnly' | 'belowReorderOnly';

/** The filters that fit each report; the server ignores the others. */
const filtersOf: Record<ReportCode, FilterKey[]> = {
  'project-cost': ['projectId'],
  stock: ['ownership', 'belowReorderOnly'],
  purchasing: ['projectId', 'overdueOnly'],
  labour: ['projectId', 'from', 'to'],
  'dpr-compliance': ['projectId', 'from', 'to'],
  pipeline: ['from', 'to', 'overdueOnly'],
  'client-material': ['projectId'],
};

const render = (cell: Cell | undefined, type: Column['type']): string => {
  if (cell === null || cell === undefined || cell === '') return '';
  if (type === 'money') return formatAmount(String(cell));
  if (type === 'date') return formatDate(String(cell));
  return String(cell);
};

const alignOf = (type: Column['type']) =>
  type === 'text' || type === 'date' ? undefined : 'right';

function ReportTable({
  section,
  title,
  ...rest
}: {
  section: Pick<Section, 'columns' | 'totals'> & { rows: Row[] };
  title?: string;
  loading?: boolean;
  sortable?: boolean;
  pagination?: TablePaginationConfig;
  onChange?: (sorter: SorterResult<Row>) => void;
}) {
  const { t } = useTranslation();
  const { columns, rows, totals } = section;
  return (
    <div style={{ marginTop: 16 }}>
      {title !== undefined && <Typography.Title level={5}>{title}</Typography.Title>}
      <Table<Row>
        size="small"
        rowKey="__key"
        loading={rest.loading ?? false}
        dataSource={rows.map((row, index) => ({ ...row, __key: index }))}
        pagination={rest.pagination ?? false}
        locale={{ emptyText: t('reports.empty') }}
        onChange={(_, __, sorter, extra) => {
          if (extra.action === 'sort') rest.onChange?.(sorter as SorterResult<Row>);
        }}
        columns={columns.map((column) => ({
          key: column.key,
          title: t(`reports.columns.${column.key}`),
          align: alignOf(column.type),
          sorter: rest.sortable === true,
          render: (_: unknown, row: Row) => render(row[column.key], column.type),
        }))}
        summary={() =>
          totals === null ? null : (
            <Table.Summary.Row>
              {columns.map((column, index) => (
                <Table.Summary.Cell key={column.key} index={index} align={alignOf(column.type)}>
                  {index === 0 && totals[column.key] === undefined
                    ? t('reports.total')
                    : render(totals[column.key], column.type)}
                </Table.Summary.Cell>
              ))}
            </Table.Summary.Row>
          )
        }
      />
    </div>
  );
}

function ReportView({ code }: { code: ReportCode }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const keys = filtersOf[code];
  const [draft, setDraft] = useState<ReportFilter>({});
  const [applied, setApplied] = useState<ReportFilter>({});
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ sort?: string; direction?: 'asc' | 'desc' }>({});
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const message = (cause: unknown) =>
    cause instanceof ApiError
      ? t(`reports.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.loadError');

  const report = useQuery({
    queryKey: ['reports', code, applied, sort, page],
    queryFn: () =>
      reportsApi.run(code, {
        ...applied,
        ...sort,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
    retry: false,
  });
  const projects = useQuery({
    queryKey: ['reports', 'projects'],
    queryFn: () => projectsApi.list({ limit: 200 }),
    enabled: keys.includes('projectId'),
    retry: false,
  });
  const saved = useQuery({
    queryKey: ['reports', 'saved', code],
    queryFn: () => reportsApi.savedFilters(code),
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => reportsApi.saveFilter(code, name.trim(), draft),
    onSuccess: async () => {
      setName('');
      setError(null);
      setNotice(t('reports.saved.saved'));
      await queryClient.invalidateQueries({ queryKey: ['reports', 'saved', code] });
    },
    onError: (cause) => setError(message(cause)),
  });
  const remove = useMutation({
    mutationFn: (filter: SavedFilter) => reportsApi.removeFilter(filter),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports', 'saved', code] }),
    onError: (cause) => setError(message(cause)),
  });
  const download = useMutation({
    mutationFn: (format: 'csv' | 'xlsx') =>
      reportsApi.download(code, { ...applied, ...sort }, format),
    onError: (cause) => setError(message(cause)),
  });

  const apply = (filter: ReportFilter) => {
    setDraft(filter);
    setApplied(filter);
    setPage(1);
    setError(null);
    setNotice(null);
  };
  const set = (patch: ReportFilter) => setDraft((current) => ({ ...current, ...patch }));
  const data = report.data;

  return (
    <div>
      <Typography.Title level={3}>{t(`reports.names.${code}`)}</Typography.Title>
      <Typography.Paragraph>{t(`reports.descriptions.${code}`)}</Typography.Paragraph>
      {error !== null && <Alert type="error" message={error} />}
      {notice !== null && <Alert type="success" message={notice} />}
      {report.isError && <Alert type="error" message={message(report.error)} />}

      <Space wrap style={{ margin: '12px 0' }}>
        {keys.includes('projectId') && (
          <Select
            allowClear
            aria-label={t('reports.filters.projectId')}
            placeholder={t('reports.filters.all')}
            style={{ width: 240 }}
            value={draft.projectId}
            onChange={(value: string | undefined) => set({ projectId: value })}
            options={(projects.data?.items ?? []).map((project) => ({
              value: project.id,
              label: `${project.code} ${project.name}`,
            }))}
          />
        )}
        {keys.includes('ownership') && (
          <Select
            allowClear
            aria-label={t('reports.filters.ownership')}
            placeholder={t('reports.filters.all')}
            style={{ width: 180 }}
            value={draft.ownership}
            onChange={(value: 'company' | 'client' | undefined) => set({ ownership: value })}
            options={(['company', 'client'] as const).map((value) => ({
              value,
              label: t(`reports.filters.${value}`),
            }))}
          />
        )}
        {(['from', 'to'] as const)
          .filter((key) => keys.includes(key))
          .map((key) => (
            <Input
              key={key}
              type="date"
              aria-label={t(`reports.filters.${key}`)}
              style={{ width: 160 }}
              value={draft[key] ?? ''}
              onChange={(event) => set({ [key]: event.target.value || undefined })}
            />
          ))}
        {(['overdueOnly', 'belowReorderOnly'] as const)
          .filter((key) => keys.includes(key))
          .map((key) => (
            <Checkbox
              key={key}
              checked={draft[key] === true}
              onChange={(event) => set({ [key]: event.target.checked ? true : undefined })}
            >
              {t(`reports.filters.${key}`)}
            </Checkbox>
          ))}
        <Button type="primary" onClick={() => apply(draft)}>
          {t('reports.filters.apply')}
        </Button>
        <Button onClick={() => apply({})}>{t('reports.filters.reset')}</Button>
        <Button loading={download.isPending} onClick={() => download.mutate('csv')}>
          {t('reports.exportCsv')}
        </Button>
        <Button loading={download.isPending} onClick={() => download.mutate('xlsx')}>
          {t('reports.exportXlsx')}
        </Button>
      </Space>

      <div>
        <Typography.Text strong>{t('reports.saved.title')}</Typography.Text>
        <Space wrap style={{ display: 'flex', margin: '8px 0' }}>
          {(saved.data?.items ?? []).length === 0 && (
            <Typography.Text type="secondary">{t('reports.saved.none')}</Typography.Text>
          )}
          {(saved.data?.items ?? []).map((filter) => (
            <Space key={filter.id}>
              <Button size="small" onClick={() => apply(filter.filter)}>
                {t('reports.saved.apply')} {filter.name}
              </Button>
              <Button size="small" danger onClick={() => remove.mutate(filter)}>
                {t('reports.saved.remove')} {filter.name}
              </Button>
            </Space>
          ))}
          <Input
            aria-label={t('reports.saved.name')}
            placeholder={t('reports.saved.name')}
            style={{ width: 220 }}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            disabled={name.trim() === ''}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('reports.saved.save')}
          </Button>
        </Space>
      </div>

      {data !== undefined && data.totals !== null && (
        <Space size="large" wrap style={{ margin: '8px 0' }}>
          {data.columns
            .filter((column) => data.totals?.[column.key] != null && column.type !== 'text')
            .map((column) => (
              <Statistic
                key={column.key}
                title={`${t('reports.total')} ${t(`reports.columns.${column.key}`)}`}
                value={render(data.totals?.[column.key], column.type)}
              />
            ))}
        </Space>
      )}

      <ReportTable
        section={{
          columns: data?.columns ?? [],
          rows: data?.items ?? [],
          totals: data?.totals ?? null,
        }}
        loading={report.isLoading}
        sortable
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          showSizeChanger: false,
          showTotal: (total) => t('reports.totalRows', { count: total }),
          onChange: setPage,
        }}
        onChange={(sorter) => {
          const field = Array.isArray(sorter) ? undefined : sorter.columnKey;
          const order = Array.isArray(sorter) ? undefined : sorter.order;
          setSort(
            field === undefined || order === undefined || order === null
              ? {}
              : { sort: String(field), direction: order === 'descend' ? 'desc' : 'asc' },
          );
          setPage(1);
        }}
      />
      {(data?.extras ?? []).map((section) => (
        <ReportTable
          key={section.key}
          section={section}
          title={t(`reports.sections.${section.key}`)}
        />
      ))}
    </div>
  );
}

/** One report: filter bar with saved filters, table with totals, export buttons. */
export function ReportPage() {
  const { code } = useParams();
  const known = reportCodes.find((candidate) => candidate === code);
  if (known === undefined) return <NotFoundPage />;
  return (
    <RequirePermission permission={reportPermission[known]}>
      <ReportView key={known} code={known} />
    </RequirePermission>
  );
}
