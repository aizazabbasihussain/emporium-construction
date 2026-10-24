import { ConflictError } from '@emporium/domain';
import { settingDefinition, validateSetting, type SettingValue } from '@emporium/domain/kernel';
import { findSetting, insertSetting, updateSetting } from '../repo/settings.repo.js';
import type { Db } from '../types.js';
import type { AuditService } from './audit.service.js';

export interface SettingView {
  key: string;
  value: SettingValue;
  description: string;
  /** 0 when the setting has never been saved and the registry default applies. */
  version: number;
}

export interface SettingsService {
  get(db: Db, key: string): Promise<SettingView>;
  /** Saves a validated value; `expectedVersion` is 0 for the first save (BR-9, BR-10). */
  set(
    input: { key: string; value: unknown; expectedVersion: number },
    ctx: { actorUserId: string | null; requestId: string | null },
    tx: Db,
  ): Promise<SettingView>;
}

export function createSettingsService(deps: { audit: AuditService }): SettingsService {
  const get: SettingsService['get'] = async (db, key) => {
    const definition = settingDefinition(key);
    const row = await findSetting(db, key);
    return {
      key,
      value: row ? (row.value as SettingValue) : definition.default,
      description: definition.description,
      version: row?.version ?? 0,
    };
  };

  return {
    get,
    async set({ key, value, expectedVersion }, ctx, tx) {
      const definition = settingDefinition(key);
      const validated = validateSetting(key, value);
      const before = await get(tx, key);
      const saved =
        before.version === 0
          ? await createFirst(
              tx,
              key,
              validated,
              definition.description,
              expectedVersion,
              ctx.actorUserId,
            )
          : await updateSetting(tx, {
              key,
              value: validated,
              expectedVersion,
              actor: ctx.actorUserId,
            });
      const after: SettingView = {
        key,
        value: saved.value as SettingValue,
        description: definition.description,
        version: saved.version,
      };
      await deps.audit.record(
        { ...ctx, action: 'setting.update', entityType: 'setting', entityId: key, before, after },
        tx,
      );
      return after;
    },
  };
}

async function createFirst(
  tx: Db,
  key: string,
  value: SettingValue,
  description: string,
  expectedVersion: number,
  actor: string | null,
) {
  if (expectedVersion !== 0) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
  return insertSetting(tx, { key, value, description, actor });
}
