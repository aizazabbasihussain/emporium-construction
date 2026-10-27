import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';

/** A readable message for a refused call: the translation of the error code, else the server text. */
export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`procurement.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');
}

/** Reads a chosen photo as base64 text for the receipt (BR-11). */
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? (reader.result.split(',')[1] ?? '') : '');
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}
