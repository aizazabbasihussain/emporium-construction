import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
  type FormRule,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { masterApi, type DuplicateInfo, type ListParams, type Versioned } from './api';

export interface Field {
  name: string;
  /** i18n key of the label. */
  label: string;
  type?: 'text' | 'textarea' | 'select' | 'multiselect' | 'checkbox';
  required?: boolean;
  options?: { value: string; label: string }[];
  rules?: FormRule[];
  /** The value cannot change once the record exists (for example a unit code). */
  lockedOnEdit?: boolean;
  allowClear?: boolean;
}

export interface CrudProps<T extends Versioned> {
  /** i18n key of the page title. */
  title: string;
  hint?: string;
  path: string;
  queryKey: string;
  idOf: (row: T) => string;
  /** Accessible name of a row, used by its edit and delete buttons. */
  nameOf: (row: T) => string;
  columns: ColumnsType<T>;
  fields: Field[];
  canManage: boolean;
  /** Search box and paging; without it every row is loaded (small reference lists). */
  searchable?: boolean;
  params?: ListParams;
  filters?: ReactNode;
  defaults?: Record<string, unknown>;
  toForm?: (row: T) => Record<string, unknown>;
  toBody?: (values: Record<string, unknown>) => Record<string, unknown>;
  /** Display-only reshaping, for example nesting rows into a tree. */
  rowsOf?: (rows: T[]) => T[];
  /** Returns the existing records the new one would repeat (parties). */
  duplicateCheck?: (body: Record<string, unknown>, row: T | null) => Promise<DuplicateInfo[]>;
  /** Extra content under the table. */
  children?: ReactNode;
}

const PAGE_SIZE = 20;

export function CrudPage<T extends Versioned>(props: CrudProps<T>) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<Record<string, unknown>>();
  const [editing, setEditing] = useState<T | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateInfo[]>([]);
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);

  const params: ListParams = {
    ...props.params,
    q: text.trim() === '' ? undefined : text.trim(),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
  const list = useQuery({
    queryKey: [props.queryKey, props.params, props.searchable ? [text, page] : 'all'],
    queryFn: async () => {
      if (props.searchable) return masterApi.list<T>(props.path, params);
      const rows = await masterApi.listAll<T>(props.path, props.params);
      return { items: rows, total: rows.length, limit: rows.length, offset: 0 };
    },
  });

  const failure = (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`master.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');

  const close = () => {
    setOpen(false);
    setEditing(null);
    setError(null);
    setDuplicates([]);
  };

  const save = useMutation({
    mutationFn: async ({
      values,
      confirm,
    }: {
      values: Record<string, unknown>;
      confirm: boolean;
    }) => {
      const body = { ...(props.toBody ? props.toBody(values) : values) };
      if (props.duplicateCheck && !confirm) {
        const found = await props.duplicateCheck(body, editing);
        if (found.length > 0) return { found };
      }
      if (confirm) body.confirmDuplicate = true;
      if (editing) {
        await masterApi.update(props.path, props.idOf(editing), {
          ...body,
          version: editing.version,
        });
      } else {
        await masterApi.create(props.path, body);
      }
      return { found: [] as DuplicateInfo[] };
    },
    onSuccess: async ({ found }) => {
      if (found.length > 0) {
        setDuplicates(found);
        return;
      }
      close();
      await queryClient.invalidateQueries({ queryKey: [props.queryKey] });
    },
    onError: (cause) => setError(failure(cause)),
  });

  const remove = useMutation({
    mutationFn: (row: T) => masterApi.remove(props.path, props.idOf(row), row.version),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [props.queryKey] }),
    onError: (cause) => setError(failure(cause)),
  });

  const start = (row: T | null) => {
    setEditing(row);
    setError(null);
    setDuplicates([]);
    setOpen(true);
    form.resetFields();
    form.setFieldsValue(
      row === null
        ? (props.defaults ?? {})
        : (props.toForm?.(row) ?? ({ ...row } as Record<string, unknown>)),
    );
  };

  const submit = (confirm: boolean) => {
    void form.validateFields().then(
      (values) => {
        setError(null);
        save.mutate({ values, confirm });
      },
      () => undefined,
    );
  };

  const namesOf = (found: DuplicateInfo[]) => found.map((d) => `${d.name} (${d.code})`).join(', ');
  const blocked = duplicates.some((d) => d.blocking);

  const columns: ColumnsType<T> = props.canManage
    ? [
        ...props.columns,
        {
          title: '',
          key: 'actions',
          render: (_, row) => (
            <Space>
              <Button size="small" onClick={() => start(row)}>
                {t('master.actions.edit')} {props.nameOf(row)}
              </Button>
              <Popconfirm
                title={t('master.actions.confirmDelete')}
                okText={t('master.actions.delete')}
                cancelText={t('common.cancel')}
                onConfirm={() => remove.mutate(row)}
              >
                <Button size="small" danger>
                  {t('master.actions.delete')} {props.nameOf(row)}
                </Button>
              </Popconfirm>
            </Space>
          ),
        },
      ]
    : props.columns;

  const rows = props.rowsOf ? props.rowsOf(list.data?.items ?? []) : (list.data?.items ?? []);

  return (
    <div>
      <Typography.Title level={3}>{t(props.title)}</Typography.Title>
      {props.hint && <Typography.Paragraph type="secondary">{t(props.hint)}</Typography.Paragraph>}
      {!props.canManage && <Alert type="info" message={t('master.noPermission')} />}
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      {!open && error !== null && <Alert type="error" message={error} />}
      <Space style={{ margin: '12px 0' }} wrap>
        {props.searchable && (
          <Input.Search
            aria-label={t('master.search')}
            placeholder={t('master.search')}
            allowClear
            onSearch={(value) => {
              setText(value);
              setPage(1);
            }}
          />
        )}
        {props.filters}
        {props.canManage && (
          <Button type="primary" onClick={() => start(null)}>
            {t('master.actions.add')}
          </Button>
        )}
      </Space>
      <Table<T>
        rowKey={props.idOf}
        loading={list.isLoading}
        dataSource={rows}
        columns={columns}
        pagination={
          props.searchable
            ? {
                current: page,
                pageSize: PAGE_SIZE,
                total: list.data?.total ?? 0,
                showSizeChanger: false,
                onChange: setPage,
              }
            : false
        }
      />
      {props.children}
      <Modal
        open={open}
        title={t(props.title)}
        onCancel={close}
        footer={null}
        destroyOnHidden
        forceRender
      >
        <Form form={form} layout="vertical" initialValues={props.defaults}>
          {props.fields.map((field) => (
            <Form.Item
              key={field.name}
              name={field.name}
              label={t(field.label)}
              valuePropName={field.type === 'checkbox' ? 'checked' : 'value'}
              rules={[
                ...(field.required && field.type !== 'checkbox'
                  ? [{ required: true, message: t('common.required') }]
                  : []),
                ...(field.rules ?? []),
              ]}
            >
              {field.type === 'checkbox' ? (
                <Checkbox />
              ) : field.type === 'select' || field.type === 'multiselect' ? (
                <Select
                  aria-label={t(field.label)}
                  mode={field.type === 'multiselect' ? 'multiple' : undefined}
                  allowClear={field.allowClear}
                  options={field.options}
                  disabled={field.lockedOnEdit && editing !== null}
                />
              ) : field.type === 'textarea' ? (
                <Input.TextArea rows={2} />
              ) : (
                <Input disabled={field.lockedOnEdit && editing !== null} />
              )}
            </Form.Item>
          ))}
          {duplicates.length > 0 && (
            <Alert
              type={blocked ? 'error' : 'warning'}
              message={t(blocked ? 'master.duplicate.blocking' : 'master.duplicate.warning', {
                names: namesOf(duplicates),
              })}
              action={
                blocked ? undefined : (
                  <Button size="small" onClick={() => submit(true)}>
                    {t('master.duplicate.saveAnyway')}
                  </Button>
                )
              }
            />
          )}
          {open && error !== null && <Alert type="error" message={error} />}
          <Space style={{ marginTop: 12 }}>
            <Button type="primary" loading={save.isPending} onClick={() => submit(false)}>
              {t('common.save')}
            </Button>
            <Button onClick={close}>{t('common.cancel')}</Button>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
