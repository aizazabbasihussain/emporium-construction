import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { itemKinds, masterdataPermissions, taxKinds } from '@emporium/shared';
import { useAuth } from '../auth/AuthProvider';
import { masterApi, type Category, type CostCode, type Item, type Unit } from './api';
import { CrudPage, type Field } from './CrudPage';
import { options } from './rules';

export function ItemsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(masterdataPermissions.itemManage);
  const categories = useQuery({
    queryKey: ['master-item-categories', 'all'],
    queryFn: () => masterApi.listAll<Category>('/master/item-categories'),
  });
  const units = useQuery({
    queryKey: ['master-units', 'all'],
    queryFn: () => masterApi.listAll<Unit>('/master/units'),
  });
  const costCodes = useQuery({
    queryKey: ['master-cost-codes', 'all'],
    queryFn: () => masterApi.listAll<CostCode>('/master/cost-codes'),
  });
  const categoryName = (id: string | null) => categories.data?.find((c) => c.id === id)?.name ?? '';
  const categoryOptions = (categories.data ?? []).map((c) => ({
    value: c.id,
    label: `${c.code} ${c.name}`,
  }));

  const itemFields: Field[] = [
    { name: 'code', label: 'master.items.code', required: true },
    { name: 'name', label: 'master.items.name', required: true },
    {
      name: 'categoryId',
      label: 'master.items.category',
      type: 'select',
      allowClear: true,
      options: categoryOptions,
    },
    {
      name: 'unitCode',
      label: 'master.items.unit',
      type: 'select',
      required: true,
      options: (units.data ?? []).map((u) => ({ value: u.code, label: `${u.code} ${u.name}` })),
    },
    {
      name: 'itemKind',
      label: 'master.items.kind',
      type: 'select',
      required: true,
      options: options(itemKinds, (k) => t(`master.items.kinds.${k}`)),
    },
    { name: 'stockable', label: 'master.items.stockable', type: 'checkbox' },
    {
      name: 'defaultTaxKind',
      label: 'master.items.taxKind',
      type: 'select',
      required: true,
      options: options(taxKinds, (k) => t(`master.items.taxKinds.${k}`)),
    },
    {
      name: 'reorderLevel',
      label: 'master.items.reorderLevel',
      rules: [{ pattern: /^\d{1,14}(\.\d{1,4})?$/, message: t('master.validation.decimal') }],
    },
    {
      name: 'defaultCostCodeId',
      label: 'master.items.defaultCostCode',
      type: 'select',
      allowClear: true,
      options: (costCodes.data ?? [])
        .filter((c) => c.active)
        .map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
    },
    { name: 'active', label: 'master.items.active', type: 'checkbox' },
  ];

  const categoryFields: Field[] = [
    { name: 'code', label: 'master.items.code', required: true },
    { name: 'name', label: 'master.items.name', required: true },
    {
      name: 'parentId',
      label: 'master.items.parent',
      type: 'select',
      allowClear: true,
      options: categoryOptions,
    },
  ];

  return (
    <div>
      <CrudPage<Item>
        title="master.items.title"
        path="/master/items"
        queryKey="master-items"
        idOf={(row) => row.id}
        nameOf={(row) => row.code}
        searchable
        canManage={canManage}
        defaults={{ itemKind: 'material', defaultTaxKind: 'goods', stockable: true, active: true }}
        fields={itemFields}
        toBody={(values) => ({
          ...values,
          categoryId: values.categoryId ?? null,
          defaultCostCodeId: values.defaultCostCodeId ?? null,
          reorderLevel: values.reorderLevel === '' ? null : (values.reorderLevel ?? null),
        })}
        columns={[
          { title: t('master.items.code'), dataIndex: 'code' },
          { title: t('master.items.name'), dataIndex: 'name' },
          { title: t('master.items.category'), render: (_, row) => categoryName(row.categoryId) },
          { title: t('master.items.unit'), dataIndex: 'unitCode' },
          {
            title: t('master.items.kind'),
            render: (_, row) => t(`master.items.kinds.${row.itemKind}`),
          },
          {
            title: t('master.items.stockable'),
            render: (_, row) => (row.stockable ? t('master.yes') : ''),
          },
        ]}
      />
      <CrudPage<Category>
        title="master.items.categories"
        path="/master/item-categories"
        queryKey="master-item-categories"
        idOf={(row) => row.id}
        nameOf={(row) => row.code}
        canManage={canManage}
        fields={categoryFields}
        toBody={(values) => ({ ...values, parentId: values.parentId ?? null })}
        columns={[
          { title: t('master.items.code'), dataIndex: 'code' },
          { title: t('master.items.name'), dataIndex: 'name' },
          { title: t('master.items.parent'), render: (_, row) => categoryName(row.parentId) },
        ]}
      />
    </div>
  );
}
