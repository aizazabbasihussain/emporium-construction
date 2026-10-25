import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { costCodeKinds, masterdataPermissions } from '@emporium/shared';
import { useAuth } from '../auth/AuthProvider';
import { masterApi, type CostCode } from './api';
import { CrudPage, type Field } from './CrudPage';
import { options } from './rules';

type Node = CostCode & { children?: Node[] };

/** Nests the flat list under each parent for display; the hierarchy itself is the API's. */
function toTree(rows: CostCode[]): Node[] {
  const nodes = new Map<string, Node>(rows.map((row) => [row.id, { ...row }]));
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent === undefined) roots.push(node);
    else (parent.children ??= []).push(node);
  }
  return roots;
}

export function CostCodesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const all = useQuery({
    queryKey: ['master-cost-codes', 'all'],
    queryFn: () => masterApi.listAll<CostCode>('/master/cost-codes'),
  });
  const fields: Field[] = [
    { name: 'code', label: 'master.costCodes.code', required: true },
    { name: 'name', label: 'master.costCodes.name', required: true },
    {
      name: 'parentId',
      label: 'master.costCodes.parent',
      type: 'select',
      allowClear: true,
      options: (all.data ?? []).map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
    },
    {
      name: 'kind',
      label: 'master.costCodes.kind',
      type: 'select',
      required: true,
      options: options(costCodeKinds, (k) => t(`master.costCodes.kinds.${k}`)),
    },
    { name: 'active', label: 'master.costCodes.active', type: 'checkbox' },
  ];
  return (
    <CrudPage<CostCode>
      title="master.costCodes.title"
      path="/master/cost-codes"
      queryKey="master-cost-codes"
      idOf={(row) => row.id}
      nameOf={(row) => row.code}
      canManage={can(masterdataPermissions.costcodeManage)}
      defaults={{ kind: 'material', active: true }}
      fields={fields}
      toBody={(values) => ({ ...values, parentId: values.parentId ?? null })}
      rowsOf={toTree}
      columns={[
        { title: t('master.costCodes.code'), dataIndex: 'code' },
        { title: t('master.costCodes.name'), dataIndex: 'name' },
        {
          title: t('master.costCodes.kind'),
          render: (_, row) => t(`master.costCodes.kinds.${row.kind}`),
        },
        {
          title: t('master.costCodes.active'),
          render: (_, row) => (row.active ? t('master.yes') : ''),
        },
      ]}
    />
  );
}
