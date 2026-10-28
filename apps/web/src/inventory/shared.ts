import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';

/** The text of a failed command: the translated rule when there is one, the server message otherwise. */
export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`inventory.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');
}

export const today = (): string => new Date().toISOString().slice(0, 10);

export const DECIMAL = /^\d{1,14}(\.\d{1,4})?$/;
