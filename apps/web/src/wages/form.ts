import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';

/** Month number 1-12 to its English name; the key is translated by the i18n files. */
export const monthKeys = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`wages.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');
}

/** An amount typed by a person: digits with at most two decimals, above zero. */
export const isAmount = (text: string): boolean =>
  /^\d{1,16}(\.\d{1,2})?$/.test(text.trim()) && Number(text) > 0;

/** Whether the period may be calculated again (BR-8) or adjusted (BR-10). */
export const canCalculate = (status: string): boolean =>
  status === 'draft' || status === 'calculated' || status === 'reopened';
export const canAdjust = (status: string): boolean =>
  status === 'calculated' || status === 'reopened';
export const canSubmit = (status: string): boolean =>
  status === 'calculated' || status === 'reopened';
