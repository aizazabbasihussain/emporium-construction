import type { FormRule } from 'antd';
import type { TFunction } from 'i18next';

// Form hints only: the API checks every rule again and stays the authority (constitution 3.5).

/** CNIC: 13 digits, hyphens allowed. */
export const cnicRule = (t: TFunction): FormRule => ({
  pattern: /^\d{5}-?\d{7}-?\d$/,
  message: t('master.validation.cnic'),
});

export const phoneRule = (t: TFunction): FormRule => ({
  pattern: /^\+?[\d\s\-().]{9,18}$/,
  message: t('master.validation.phone'),
});

export const dateRule = (t: TFunction): FormRule => ({
  pattern: /^\d{4}-\d{2}-\d{2}$/,
  message: t('master.validation.date'),
});

export const decimalRule = (t: TFunction): FormRule => ({
  pattern: /^\d{1,14}(\.\d{1,6})?$/,
  message: t('master.validation.decimal'),
});

export const options = (values: readonly string[], label: (value: string) => string) =>
  values.map((value) => ({ value, label: label(value) }));
