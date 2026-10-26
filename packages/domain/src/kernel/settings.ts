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
  // H-15 working defaults for new estimates; percentages are decimal text so 7.5 is possible.
  'estimation.overhead_percent': {
    type: 'string',
    description: 'Overhead percent copied into a new estimate (H-15)',
    default: '10',
  },
  'estimation.contingency_percent': {
    type: 'string',
    description: 'Contingency percent copied into a new estimate (H-15)',
    default: '5',
  },
  'estimation.target_margin_percent': {
    type: 'string',
    description: 'Target margin percent shown against a new estimate (H-15)',
    default: '15',
  },
  // H-09: no margin floor for now; a quotation below the floor is flagged on its approval request.
  'quotations.margin_floor_percent': {
    type: 'string',
    description: 'Margin percent below which a quotation approval request is flagged (H-09)',
    default: '0',
  },
  // P1-09 BR-8: spending at or above this share of a budget line is flagged; it is never blocked.
  'projects.budget_warning_percent': {
    type: 'integer',
    description: 'Share of a budget line, in percent, at which spending is flagged',
    default: 90,
    min: 1,
    max: 100,
  },
  // P1-09 BR-11: P3-02 switches it on when work orders become cost objects.
  'projects.work_orders_enabled': {
    type: 'boolean',
    description: 'Whether work orders may carry cost entries (Phase 3)',
    default: false,
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
