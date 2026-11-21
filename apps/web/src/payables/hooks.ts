import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { ApiError } from '../admin/api';
import { cashbookApi } from '../cashbook/api';
import { masterApi, type Party } from '../master/api';

/** Active vendors, for every vendor picker of the module. */
export function useVendors() {
  const query = useQuery({
    queryKey: ['master-parties', 'vendors'],
    queryFn: () =>
      masterApi.listAll<Party>('/master/parties', { role: 'vendor', status: 'active' }),
  });
  const vendors = query.data ?? [];
  return {
    vendors,
    options: vendors.map((p) => ({ value: p.id, label: p.name })),
    nameOf: (id: string) => vendors.find((p) => p.id === id)?.name ?? id,
  };
}

/** The cash book accounts a payment can be paid from. */
export function useAccounts() {
  const query = useQuery({
    queryKey: ['cashbook', 'accounts', false],
    queryFn: () => cashbookApi.accounts(false),
  });
  return (query.data ?? []).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }));
}

export const today = (): string => new Date().toISOString().slice(0, 10);

/** The text shown for a failed command: the module's own message for the code when it has one. */
export const failure = (t: TFunction, error: unknown): string =>
  error instanceof ApiError
    ? t(`payables.errors.${error.code}`, { defaultValue: error.message })
    : t('common.loadError');
