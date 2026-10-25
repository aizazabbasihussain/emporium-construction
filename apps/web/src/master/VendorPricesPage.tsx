import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatDate, masterdataPermissions } from '@emporium/shared';
import { useAuth } from '../auth/AuthProvider';
import { masterApi, type Item, type Party, type Unit, type VendorPrice } from './api';
import { CrudPage, type Field } from './CrudPage';
import { dateRule } from './rules';

export function VendorPricesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const vendors = useQuery({
    queryKey: ['master-parties', 'vendors'],
    queryFn: () =>
      masterApi.listAll<Party>('/master/parties', { role: 'vendor', status: 'active' }),
  });
  const items = useQuery({
    queryKey: ['master-items', 'all'],
    queryFn: () => masterApi.listAll<Item>('/master/items', { active: 'true' }),
  });
  const units = useQuery({
    queryKey: ['master-units', 'all'],
    queryFn: () => masterApi.listAll<Unit>('/master/units'),
  });
  const vendorName = (id: string) => vendors.data?.find((v) => v.id === id)?.name ?? id;
  const itemName = (id: string) => items.data?.find((i) => i.id === id)?.name ?? id;

  const fields: Field[] = [
    {
      name: 'vendorId',
      label: 'master.prices.vendor',
      type: 'select',
      required: true,
      options: (vendors.data ?? []).map((v) => ({ value: v.id, label: `${v.code} ${v.name}` })),
    },
    {
      name: 'itemId',
      label: 'master.prices.item',
      type: 'select',
      required: true,
      options: (items.data ?? []).map((i) => ({ value: i.id, label: `${i.code} ${i.name}` })),
    },
    {
      name: 'unitCode',
      label: 'master.prices.unit',
      type: 'select',
      required: true,
      options: (units.data ?? []).map((u) => ({ value: u.code, label: u.code })),
    },
    {
      name: 'rate',
      label: 'master.prices.rate',
      required: true,
      rules: [{ pattern: /^\d{1,14}(\.\d{1,4})?$/, message: t('master.validation.decimal') }],
    },
    { name: 'validFrom', label: 'master.prices.validFrom', required: true, rules: [dateRule(t)] },
    { name: 'validTo', label: 'master.prices.validTo', rules: [dateRule(t)] },
  ];

  return (
    <CrudPage<VendorPrice>
      title="master.prices.title"
      path="/master/vendor-prices"
      queryKey="master-vendor-prices"
      idOf={(row) => row.id}
      nameOf={(row) => `${itemName(row.itemId)} ${row.validFrom}`}
      searchable
      canManage={can(masterdataPermissions.priceManage)}
      fields={fields}
      toBody={(values) => ({
        ...values,
        validTo: values.validTo === '' ? null : (values.validTo ?? null),
      })}
      columns={[
        { title: t('master.prices.vendor'), render: (_, row) => vendorName(row.vendorId) },
        { title: t('master.prices.item'), render: (_, row) => itemName(row.itemId) },
        { title: t('master.prices.unit'), dataIndex: 'unitCode' },
        { title: t('master.prices.rate'), dataIndex: 'rate' },
        { title: t('master.prices.validFrom'), render: (_, row) => formatDate(row.validFrom) },
        {
          title: t('master.prices.validTo'),
          render: (_, row) => (row.validTo ? formatDate(row.validTo) : ''),
        },
      ]}
    />
  );
}
