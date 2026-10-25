import { formatDate, valuationMethods, valuationPermissions } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Select, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { masterApi, type Category } from '../master/api';
import { valuationApi, type Policy } from './api';

const today = () => new Date().toISOString().slice(0, 10);
const byNewest = (a: Policy, b: Policy) => b.effectiveFrom.localeCompare(a.effectiveFrom);
const inForce = (list: Policy[]): Policy | undefined =>
  list.filter((policy) => policy.effectiveFrom <= today()).sort(byNewest)[0];

/**
 * Valuation settings: the company default, the category overrides and the changes that are
 * pending or still to start (spec P1-13 section 5). The API checks every rule; this page only
 * collects the request.
 */
export function ValuationSettingsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<'company' | 'category'>('company');
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [method, setMethod] = useState<(typeof valuationMethods)[number] | undefined>(undefined);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const policies = useQuery({
    queryKey: ['valuation', 'policies'],
    queryFn: valuationApi.policies,
  });
  const categories = useQuery({
    queryKey: ['valuation', 'categories'],
    queryFn: () => masterApi.listAll<Category>('/master/item-categories'),
    retry: false,
  });
  const categoryName = (id: string | null) =>
    categories.data?.find((category) => category.id === id)?.name ?? id ?? '';

  const request = useMutation({
    mutationFn: (chosen: (typeof valuationMethods)[number]) =>
      valuationApi.requestPolicy({
        scope,
        categoryId: scope === 'category' ? categoryId : undefined,
        method: chosen,
        effectiveFrom,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['valuation'] });
      setOpen(false);
      setDone(true);
      setError(null);
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`valuation.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  const submit = () => {
    if (scope === 'category' && categoryId === undefined) {
      setError(t('valuation.settings.chooseCategory'));
    } else if (method === undefined) {
      setError(t('valuation.settings.chooseMethod'));
    } else if (effectiveFrom === '') {
      setError(t('valuation.settings.chooseDate'));
    } else {
      setError(null);
      request.mutate(method);
    }
  };

  const all = policies.data?.items ?? [];
  const approved = all.filter((policy) => policy.status === 'active');
  const company = inForce(approved.filter((policy) => policy.scope === 'company'));
  const overrideCategories = [
    ...new Set(
      approved.filter((policy) => policy.scope === 'category').map((policy) => policy.categoryId),
    ),
  ];
  const overrides = overrideCategories
    .map((id) =>
      inForce(approved.filter((policy) => policy.scope === 'category' && policy.categoryId === id)),
    )
    .filter((policy): policy is Policy => policy !== undefined);
  const upcoming = all.filter(
    (policy) =>
      policy.status === 'pending_approval' ||
      (policy.status === 'active' && policy.effectiveFrom > today()),
  );

  const methodLabel = (value: string) => t(`valuation.method.${value}`);
  const columns = [
    {
      title: t('valuation.settings.category'),
      render: (_: unknown, row: Policy) => categoryName(row.categoryId),
    },
    {
      title: t('valuation.settings.method'),
      render: (_: unknown, row: Policy) => methodLabel(row.method),
    },
    {
      title: t('valuation.settings.effectiveFrom'),
      render: (_: unknown, row: Policy) => formatDate(row.effectiveFrom),
    },
  ];

  return (
    <div>
      <Typography.Title level={3}>{t('valuation.settings.title')}</Typography.Title>
      <Typography.Paragraph>{t('valuation.settings.hint')}</Typography.Paragraph>
      {policies.isError && <Alert type="error" message={t('common.loadError')} />}
      {done && <Alert type="success" message={t('valuation.settings.requested')} closable />}
      {can(valuationPermissions.policyRequest) && (
        <Button type="primary" onClick={() => setOpen(true)} style={{ margin: '12px 0' }}>
          {t('valuation.settings.request')}
        </Button>
      )}

      <Typography.Title level={4}>{t('valuation.settings.companyDefault')}</Typography.Title>
      <Typography.Paragraph>
        {company === undefined ? (
          t('valuation.settings.noneInForce')
        ) : (
          <>
            <Tag color="blue">{methodLabel(company.method)}</Tag>
            {formatDate(company.effectiveFrom)}
          </>
        )}
      </Typography.Paragraph>

      <Typography.Title level={4}>{t('valuation.settings.overrides')}</Typography.Title>
      <Table<Policy>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('valuation.settings.noOverrides') }}
        dataSource={overrides}
        columns={columns}
      />

      <Typography.Title level={4}>{t('valuation.settings.upcoming')}</Typography.Title>
      <Table<Policy>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('valuation.settings.noUpcoming') }}
        dataSource={upcoming}
        columns={[
          {
            title: t('valuation.settings.scope'),
            render: (_, row) => t(`valuation.scope.${row.scope}`),
          },
          ...columns,
          {
            title: t('valuation.settings.status'),
            render: (_, row) => t(`valuation.status.${row.status}`),
          },
        ]}
      />

      <Modal
        open={open}
        title={t('valuation.settings.requestTitle')}
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form layout="vertical">
          {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
          <Form.Item label={t('valuation.settings.scope')}>
            <Select
              aria-label={t('valuation.settings.scope')}
              value={scope}
              onChange={(value: 'company' | 'category') => setScope(value)}
              options={(['company', 'category'] as const).map((value) => ({
                value,
                label: t(`valuation.scope.${value}`),
              }))}
            />
          </Form.Item>
          {scope === 'category' && (
            <Form.Item label={t('valuation.settings.category')}>
              <Select
                aria-label={t('valuation.settings.category')}
                value={categoryId}
                onChange={setCategoryId}
                options={(categories.data ?? []).map((category) => ({
                  value: category.id,
                  label: category.name,
                }))}
              />
            </Form.Item>
          )}
          <Form.Item label={t('valuation.settings.method')}>
            <Select
              aria-label={t('valuation.settings.method')}
              value={method}
              onChange={setMethod}
              options={valuationMethods.map((value) => ({ value, label: methodLabel(value) }))}
            />
          </Form.Item>
          <Form.Item label={t('valuation.settings.effectiveFrom')}>
            <Input
              type="date"
              aria-label={t('valuation.settings.effectiveFrom')}
              min={today()}
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </Form.Item>
          <Button type="primary" loading={request.isPending} onClick={submit}>
            {t('valuation.settings.submit')}
          </Button>
        </Form>
      </Modal>
    </div>
  );
}
