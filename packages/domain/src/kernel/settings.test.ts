import { describe, expect, it } from 'vitest';
import { settingDefinition, validateSetting, type SettingRegistry } from './settings.js';

const registry: SettingRegistry = {
  n: { type: 'integer', description: 'n', default: 1 },
  s: { type: 'string', description: 's', default: 'a' },
  b: { type: 'boolean', description: 'b', default: false },
};

describe('settings (BR-9, T-7)', () => {
  it('knows backdating_days with default 3', () => {
    expect(settingDefinition('backdating_days').default).toBe(3);
    expect(validateSetting('backdating_days', 5)).toBe(5);
  });

  it('rejects unknown keys, including inherited property names', () => {
    expect(() => validateSetting('nope', 1)).toThrow(/Unknown setting/);
    expect(() => validateSetting('toString', 1)).toThrow(/Unknown setting/);
  });

  it('rejects wrong types and out-of-range integers', () => {
    expect(() => validateSetting('backdating_days', '3')).toThrow(/Invalid value/);
    expect(() => validateSetting('backdating_days', 1.5)).toThrow(/Invalid value/);
    expect(() => validateSetting('backdating_days', -1)).toThrow(/Invalid value/);
    expect(() => validateSetting('backdating_days', 366)).toThrow(/Invalid value/);
  });

  it('validates integer without bounds, string and boolean', () => {
    expect(validateSetting('n', -50, registry)).toBe(-50);
    expect(validateSetting('s', 'x', registry)).toBe('x');
    expect(validateSetting('b', true, registry)).toBe(true);
    expect(() => validateSetting('s', 1, registry)).toThrow(/Invalid value/);
    expect(() => validateSetting('b', 'true', registry)).toThrow(/Invalid value/);
  });
});
