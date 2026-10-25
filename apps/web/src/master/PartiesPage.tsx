import { Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { masterdataPermissions, partyRoles, partyStatuses } from '@emporium/shared';
import { useAuth } from '../auth/AuthProvider';
import { masterApi, type Party } from './api';
import { CrudPage, type Field } from './CrudPage';
import { cnicRule, options, phoneRule } from './rules';

export function PartiesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [role, setRole] = useState<string | undefined>(undefined);

  const fields: Field[] = [
    { name: 'name', label: 'master.parties.name', required: true },
    { name: 'legalName', label: 'master.parties.legalName' },
    {
      name: 'roles',
      label: 'master.parties.roles',
      type: 'multiselect',
      required: true,
      options: options(partyRoles, (r) => t(`master.parties.role.${r}`)),
      rules: [{ type: 'array', min: 1, message: t('master.validation.rolesRequired') }],
    },
    { name: 'ntn', label: 'master.parties.ntn' },
    { name: 'strn', label: 'master.parties.strn' },
    { name: 'cnic', label: 'master.parties.cnic', rules: [cnicRule(t)] },
    { name: 'phone', label: 'master.parties.phone', rules: [phoneRule(t)] },
    { name: 'email', label: 'master.parties.email', rules: [{ type: 'email' }] },
    { name: 'address', label: 'master.parties.address' },
    { name: 'city', label: 'master.parties.city' },
    {
      name: 'status',
      label: 'master.parties.status',
      type: 'select',
      options: options(partyStatuses, (s) => t(`master.status.${s}`)),
    },
    { name: 'notes', label: 'master.parties.notes', type: 'textarea' },
  ];

  return (
    <CrudPage<Party>
      title="master.parties.title"
      path="/master/parties"
      queryKey="master-parties"
      idOf={(row) => row.id}
      nameOf={(row) => row.code}
      searchable
      params={{ role, sort: 'name' }}
      canManage={can(masterdataPermissions.partyManage)}
      defaults={{ roles: ['vendor'], status: 'active' }}
      fields={fields}
      toBody={(values) => ({ ...values, status: values.status ?? 'active' })}
      duplicateCheck={async (body, row) => {
        const result = await masterApi.checkDuplicate({
          name: body.name,
          phone: body.phone,
          ntn: body.ntn,
          cnic: body.cnic,
          excludeId: row?.id,
        });
        return result.duplicates;
      }}
      filters={
        <Select
          aria-label={t('master.parties.filterRole')}
          placeholder={t('master.parties.filterRole')}
          allowClear
          style={{ width: 200 }}
          value={role}
          onChange={(value: string | undefined) => setRole(value)}
          options={options(partyRoles, (r) => t(`master.parties.role.${r}`))}
        />
      }
      columns={[
        { title: t('master.parties.code'), dataIndex: 'code' },
        { title: t('master.parties.name'), dataIndex: 'name' },
        {
          title: t('master.parties.roles'),
          render: (_, row) => row.roles.map((r) => t(`master.parties.role.${r}`)).join(', '),
        },
        { title: t('master.parties.phone'), dataIndex: 'phone' },
        { title: t('master.parties.city'), dataIndex: 'city' },
        { title: t('master.parties.status'), render: (_, row) => t(`master.status.${row.status}`) },
      ]}
    />
  );
}
