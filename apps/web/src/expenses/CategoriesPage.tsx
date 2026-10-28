import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Select, Space, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLineReferences } from '../estimation/lists';
import { expensesApi, type CategoryBody } from './api';
import { useErrorText } from './shared';

interface Row {
  code: string;
  name: string;
  defaultCostCodeId: string;
  receiptRequired: boolean;
  maxWithoutReceipt: string;
}

const blank = (): Row => ({
  code: '',
  name: '',
  defaultCostCodeId: '',
  receiptRequired: false,
  maxWithoutReceipt: '0',
});

/** The expense categories: which ones need a receipt, and above what amount. */
export function CategoriesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const { costCodeOptions } = useLineReferences();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const categories = useQuery({
    queryKey: ['expense-categories'],
    queryFn: expensesApi.categories,
  });
  useEffect(() => {
    if (categories.data === undefined) return;
    setRows(
      categories.data.map((c) => ({
        code: c.code,
        name: c.name,
        defaultCostCodeId: c.defaultCostCodeId ?? '',
        receiptRequired: c.receiptRequired,
        maxWithoutReceipt: c.maxWithoutReceipt,
      })),
    );
  }, [categories.data]);

  const patch = (index: number, change: Partial<Row>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  const save = useMutation({
    mutationFn: () =>
      expensesApi.saveCategories(
        rows.map((row): CategoryBody => ({
          code: row.code.trim(),
          name: row.name.trim(),
          defaultCostCodeId: row.defaultCostCodeId === '' ? null : row.defaultCostCodeId,
          receiptRequired: row.receiptRequired,
          maxWithoutReceipt: row.maxWithoutReceipt.trim(),
        })),
      ),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['expense-categories'] });
    },
    onError: (cause) => {
      setSaved(false);
      setError(errorText(cause));
    },
  });

  const submit = () => {
    const bad = rows.some(
      (row) => !/^[a-z][a-z0-9_]*$/.test(row.code.trim()) || row.name.trim() === '',
    );
    if (bad) {
      setError(t('expenses.categories.incomplete'));
      return;
    }
    setError(null);
    save.mutate();
  };

  return (
    <div>
      <Typography.Title level={3}>{t('expenses.categories.title')}</Typography.Title>
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {saved && <Alert type="success" message={t('common.saved')} style={{ marginBottom: 12 }} />}
      <Table<Row>
        rowKey={(_, index) => String(index)}
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={rows}
        columns={[
          {
            title: t('expenses.categories.code'),
            render: (_, row, index) => (
              <Input
                aria-label={`${t('expenses.categories.code')} ${index + 1}`}
                value={row.code}
                onChange={(event) => patch(index, { code: event.target.value })}
              />
            ),
          },
          {
            title: t('expenses.categories.name'),
            render: (_, row, index) => (
              <Input
                aria-label={`${t('expenses.categories.name')} ${index + 1}`}
                value={row.name}
                onChange={(event) => patch(index, { name: event.target.value })}
              />
            ),
          },
          {
            title: t('expenses.categories.defaultCostCode'),
            render: (_, row, index) => (
              <Select
                aria-label={`${t('expenses.categories.defaultCostCode')} ${index + 1}`}
                allowClear
                style={{ width: 200 }}
                value={row.defaultCostCodeId === '' ? undefined : row.defaultCostCodeId}
                options={costCodeOptions}
                onChange={(value: string | undefined) =>
                  patch(index, { defaultCostCodeId: value ?? '' })
                }
              />
            ),
          },
          {
            title: t('expenses.categories.receiptRequired'),
            render: (_, row, index) => (
              <Checkbox
                aria-label={`${t('expenses.categories.receiptRequired')} ${index + 1}`}
                checked={row.receiptRequired}
                onChange={(event) => patch(index, { receiptRequired: event.target.checked })}
              />
            ),
          },
          {
            title: t('expenses.categories.maxWithoutReceipt'),
            render: (_, row, index) => (
              <Input
                aria-label={`${t('expenses.categories.maxWithoutReceipt')} ${index + 1}`}
                inputMode="decimal"
                value={row.maxWithoutReceipt}
                onChange={(event) => patch(index, { maxWithoutReceipt: event.target.value })}
              />
            ),
          },
        ]}
      />
      <Space style={{ marginTop: 12 }}>
        <Button onClick={() => setRows([...rows, blank()])}>{t('expenses.categories.add')}</Button>
        <Button type="primary" loading={save.isPending} onClick={submit}>
          {t('common.save')}
        </Button>
      </Space>
    </div>
  );
}
