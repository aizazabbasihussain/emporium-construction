import { useTranslation } from 'react-i18next';
import { masterdataPermissions, regions } from '@emporium/shared';
import { useAuth } from '../auth/AuthProvider';
import type { Location } from './api';
import { CrudPage, type Field } from './CrudPage';
import { options } from './rules';

export function LocationsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const fields: Field[] = [
    { name: 'name', label: 'master.locations.name', required: true },
    {
      name: 'region',
      label: 'master.locations.region',
      type: 'select',
      required: true,
      options: options(regions, (r) => t(`master.locations.regions.${r}`)),
    },
    { name: 'city', label: 'master.locations.city', required: true },
  ];
  return (
    <CrudPage<Location>
      title="master.locations.title"
      path="/master/locations"
      queryKey="master-locations"
      idOf={(row) => row.id}
      nameOf={(row) => row.name}
      canManage={can(masterdataPermissions.companyManage)}
      fields={fields}
      columns={[
        { title: t('master.locations.name'), dataIndex: 'name' },
        {
          title: t('master.locations.region'),
          render: (_, row) => t(`master.locations.regions.${row.region}`),
        },
        { title: t('master.locations.city'), dataIndex: 'city' },
      ]}
    />
  );
}
