import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { karachiToday } from '../attendance/form';

export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`workerportal.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.loadError');
}

/** The month the worker sees first: this month in Karachi, as `yyyy-mm`. */
export const currentMonth = (now = new Date()): string => karachiToday(now).slice(0, 7);

export const isMonth = (text: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(text);
