import { useQuery } from '@tanstack/react-query';
import { useLineReferences } from '../estimation/lists';
import { masterApi, type Item, type Party } from '../master/api';
import { projectsApi } from '../projects/api';
import type { Option } from './LinesEditor';

/** The reference lists the procurement screens pick from: items, cost codes, vendors, projects. */
export function useProcurementReferences() {
  const { costCodeOptions } = useLineReferences();
  const items = useQuery({
    queryKey: ['master-items', 'active'],
    queryFn: () => masterApi.listAll<Item>('/master/items', { active: 'true' }),
  });
  const vendors = useQuery({
    queryKey: ['master-vendors', 'active'],
    queryFn: () =>
      masterApi.listAll<Party>('/master/parties', { role: 'vendor', status: 'active' }),
  });
  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectsApi.list({ limit: 200 }),
  });
  const itemOptions: Option[] = (items.data ?? []).map((i) => ({
    value: i.id,
    label: `${i.code} ${i.name}`,
  }));
  const vendorOptions: Option[] = (vendors.data ?? []).map((v) => ({ value: v.id, label: v.name }));
  const projectOptions: Option[] = (projects.data?.items ?? []).map((p) => ({
    value: p.id,
    label: `${p.code} ${p.name}`,
  }));
  const nameIn = (options: Option[]) => (id: string) =>
    options.find((o) => o.value === id)?.label ?? id;
  return {
    costCodeOptions,
    itemOptions,
    vendorOptions,
    projectOptions,
    itemName: nameIn(itemOptions),
    vendorName: nameIn(vendorOptions),
    projectName: nameIn(projectOptions),
  };
}
