import { formatAmount } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { ApiError } from '../admin/api';
import { masterApi, type CostCode, type Party } from '../master/api';
import { projectsApi, type Project } from '../projects/api';

/** Active subcontractors and labour contractors, for every picker of the module. */
export function useSubcontractors() {
  const query = useQuery({
    queryKey: ['master-parties', 'subcontractors'],
    queryFn: async () => {
      const [subs, labour] = await Promise.all([
        masterApi.listAll<Party>('/master/parties', { role: 'subcontractor', status: 'active' }),
        masterApi.listAll<Party>('/master/parties', {
          role: 'labour_contractor',
          status: 'active',
        }),
      ]);
      return [...subs, ...labour.filter((l) => !subs.some((s) => s.id === l.id))];
    },
  });
  const parties = query.data ?? [];
  return {
    options: parties.map((p) => ({ value: p.id, label: p.name })),
    nameOf: (id: string) => parties.find((p) => p.id === id)?.name ?? id,
  };
}

/** Active projects: a work order is for one of them. */
export function useProjects() {
  const query = useQuery({
    queryKey: ['subcontracts', 'projects'],
    queryFn: () => projectsApi.list({ status: 'active', limit: 200 }),
  });
  const projects: Project[] = query.data?.items ?? [];
  return {
    options: projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
    nameOf: (id: string) => projects.find((p) => p.id === id)?.name ?? id,
  };
}

export function useCostCodes() {
  const query = useQuery({
    queryKey: ['master-cost-codes', 'all'],
    queryFn: () => masterApi.listAll<CostCode>('/master/cost-codes'),
  });
  const codes = query.data ?? [];
  return {
    options: codes.map((c) => ({ value: c.id, label: `${c.code} ${c.name}` })),
    /** The subcontractors code (H-25: 300), preselected on a new work order. */
    subcontractCode: codes.find((c) => c.code === '300')?.id ?? '',
  };
}

export const today = (): string => new Date().toISOString().slice(0, 10);

/** BR-9: an amount the API withheld shows as a dash. */
export const amountText = (value: string | null): string =>
  value === null ? '—' : formatAmount(value);

/** The text shown for a failed command: the module's own message for the code when it has one. */
export const failure = (t: TFunction, error: unknown): string =>
  error instanceof ApiError
    ? t(`subcontracts.errors.${error.code}`, { defaultValue: error.message })
    : t('common.loadError');
