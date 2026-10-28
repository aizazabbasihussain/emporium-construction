import { useQuery } from '@tanstack/react-query';
import { useLineReferences } from '../estimation/lists';
import { masterApi, type Item, type Party } from '../master/api';
import { projectsApi } from '../projects/api';
import { inventoryApi } from './api';

export interface Option {
  value: string;
  label: string;
}

/** The reference lists the inventory screens pick from: stores, items, projects, clients, cost codes. */
export function useInventoryReferences() {
  const { costCodeOptions } = useLineReferences();
  const stores = useQuery({ queryKey: ['inventory-stores'], queryFn: inventoryApi.stores });
  const items = useQuery({
    queryKey: ['master-items', 'active'],
    queryFn: () => masterApi.listAll<Item>('/master/items', { active: 'true' }),
  });
  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectsApi.list({ limit: 200 }),
  });
  const clients = useQuery({
    queryKey: ['master-clients', 'active'],
    queryFn: () =>
      masterApi.listAll<Party>('/master/parties', { role: 'client', status: 'active' }),
  });
  const storeOptions: Option[] = (stores.data?.items ?? [])
    .filter((s) => s.active)
    .map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }));
  const itemOptions: Option[] = (items.data ?? [])
    .filter((i) => i.stockable)
    .map((i) => ({ value: i.id, label: `${i.code} ${i.name}` }));
  const projectOptions: Option[] = (projects.data?.items ?? []).map((p) => ({
    value: p.id,
    label: `${p.code} ${p.name}`,
  }));
  const clientOptions: Option[] = (clients.data ?? []).map((c) => ({ value: c.id, label: c.name }));
  const nameIn = (options: Option[]) => (id: string) =>
    options.find((o) => o.value === id)?.label ?? id;
  return {
    costCodeOptions,
    storeOptions,
    itemOptions,
    projectOptions,
    clientOptions,
    /** The default cost code of an item, shown on the issue form (BR-3). */
    defaultCostCode: (itemId: string): string | null =>
      items.data?.find((i) => i.id === itemId)?.defaultCostCodeId ?? null,
    storeName: nameIn(storeOptions),
    itemName: nameIn(itemOptions),
  };
}
