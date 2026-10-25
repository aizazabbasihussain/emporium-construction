import { useQuery } from '@tanstack/react-query';
import { masterApi, type CostCode, type Unit } from '../master/api';

/** The cost codes and units a line can use; both are small reference lists. */
export function useLineReferences() {
  const costCodes = useQuery({
    queryKey: ['master-cost-codes', 'all'],
    queryFn: () => masterApi.listAll<CostCode>('/master/cost-codes'),
  });
  const units = useQuery({
    queryKey: ['master-units', 'all'],
    queryFn: () => masterApi.listAll<Unit>('/master/units'),
  });
  return {
    costCodeOptions: (costCodes.data ?? []).map((c) => ({
      value: c.id,
      label: `${c.code} ${c.name}`,
    })),
    unitOptions: (units.data ?? []).map((u) => ({ value: u.code, label: u.code })),
  };
}
