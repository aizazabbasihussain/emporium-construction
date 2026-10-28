import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';

/** A readable message for a refused call: the translation of the error code, else the server text. */
export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`expenses.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');
}
