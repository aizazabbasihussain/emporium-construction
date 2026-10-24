import { ValidationError } from '../errors.js';

export type SettingValue = number | string | boolean;

export interface SettingDefinition {
  type: 'integer' | 'string' | 'boolean';
  description: string;
  default: SettingValue;
  min?: number;
  max?: number;
}

export type SettingRegistry = Record<string, SettingDefinition>;

/** Typed registry of settings (BR-9). Other specs add their keys here. */
export const settingRegistry: SettingRegistry = {
  backdating_days: {
    type: 'integer',
    description: 'Days a business date may precede today (H-24)',
    default: 3,
    min: 0,
    max: 365,
  },
  import_date_formats: {
    type: 'string',
    description: 'Date spellings accepted in import files: iso, dmy or both',
    default: 'both',
  },
};

export function settingDefinition(
  key: string,
  registry: SettingRegistry = settingRegistry,
): SettingDefinition {
  const def = Object.hasOwn(registry, key) ? registry[key] : undefined;
  if (!def) throw new ValidationError('unknown_setting', `Unknown setting: ${key}`);
  return def;
}

/** Validate a value for a key and return it; unknown keys and wrong types are rejected. */
export function validateSetting(
  key: string,
  value: unknown,
  registry: SettingRegistry = settingRegistry,
): SettingValue {
  const def = settingDefinition(key, registry);
  const invalid = new ValidationError('invalid_setting', `Invalid value for setting ${key}`);
  if (def.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid;
    if (value < (def.min ?? -Infinity) || value > (def.max ?? Infinity)) throw invalid;
    return value;
  }
  if (typeof value !== (def.type === 'boolean' ? 'boolean' : 'string')) throw invalid;
  return value as SettingValue;
}
