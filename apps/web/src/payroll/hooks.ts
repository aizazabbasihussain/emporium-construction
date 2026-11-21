import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { ApiError } from '../admin/api';
import { cashbookApi } from '../cashbook/api';

/** The cash book accounts a wage payment can be paid from. */
export function useAccounts() {
  const query = useQuery({
    queryKey: ['cashbook', 'accounts', false],
    queryFn: () => cashbookApi.accounts(false),
  });
  return (query.data ?? []).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }));
}

export const today = (): string => new Date().toISOString().slice(0, 10);

export const monthLabel = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, '0')}`;

/** The text shown for a failed command: the module's own message for the code when it has one. */
export const failure = (t: TFunction, error: unknown): string =>
  error instanceof ApiError
    ? t(`payroll.errors.${error.code}`, { defaultValue: error.message })
    : t('common.loadError');
