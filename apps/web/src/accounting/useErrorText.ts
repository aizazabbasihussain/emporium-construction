import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';

/** The wording of an error from the accounting endpoints; the API's own message when there is none. */
export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`accounting.errors.${cause.code}`, { defaultValue: cause.message, detail: cause.message })
      : t('common.loadError');
}
