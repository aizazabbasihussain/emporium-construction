import { estimationPermissions } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { estimationApi, type Template, type TemplateSummary } from './api';
import { TemplateEditor } from './TemplateEditor';

const PAGE_SIZE = 20;

export function TemplatesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [loadError, setLoadError] = useState(false);

  const templates = useQuery({
    queryKey: ['estimation', 'templates', text, page],
    queryFn: () =>
      estimationApi.templates({
        q: text.trim() === '' ? undefined : text.trim(),
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
  });
  const canManage = can(estimationPermissions.templateManage);

  const edit = async (row: TemplateSummary) => {
    try {
      setLoadError(false);
      setEditing(await estimationApi.template(row.id));
    } catch {
      setLoadError(true);
    }
  };

  return (
    <div>
      <Typography.Title level={3}>{t('estimation.template.title')}</Typography.Title>
      {(templates.isError || loadError) && <Alert type="error" message={t('common.loadError')} />}
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
        {canManage && (
          <Button type="primary" onClick={() => setEditing('new')}>
            {t('estimation.template.new')}
          </Button>
        )}
      </Space>
      <Table<TemplateSummary>
        rowKey="id"
        loading={templates.isLoading}
        dataSource={templates.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: templates.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          { title: t('estimation.template.code'), dataIndex: 'code' },
          { title: t('estimation.template.name'), dataIndex: 'name' },
          {
            title: t('estimation.workType.label'),
            render: (_, row) => t(`estimation.workType.${row.workType}`),
          },
          {
            title: t('estimation.template.active'),
            render: (_, row) =>
              row.active ? <Tag color="green">{t('common.yes')}</Tag> : <Tag>{t('common.no')}</Tag>,
          },
          {
            render: (_, row) =>
              canManage && (
                <Button onClick={() => void edit(row)}>
                  {t('common.edit')} {row.code}
                </Button>
              ),
          },
        ]}
      />
      {editing !== null && (
        <TemplateEditor
          open
          template={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
