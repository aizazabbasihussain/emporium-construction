import { updateWithVersion } from '@emporium/db';
import type { Db } from '../types.js';

export interface SettingRow {
  key: string;
  value: unknown;
  description: string | null;
  version: number;
}

export async function findSetting(db: Db, key: string): Promise<SettingRow | undefined> {
  const rows = await db.query<SettingRow>(
    'select key, value, description, version from sys_settings where key = $1 and deleted_at is null',
    [key],
  );
  return rows[0];
}

export async function insertSetting(
  db: Db,
  setting: { key: string; value: unknown; description: string; actor: string | null },
): Promise<SettingRow> {
  const rows = await db.query<SettingRow>(
    `insert into sys_settings (key, value, description, created_by, updated_by)
     values ($1, $2::jsonb, $3, $4, $4)
     returning key, value, description, version`,
    [setting.key, JSON.stringify(setting.value), setting.description, setting.actor],
  );
  return rows[0] as SettingRow;
}

export function updateSetting(
  db: Db,
  setting: { key: string; value: unknown; expectedVersion: number; actor: string | null },
): Promise<SettingRow> {
  return updateWithVersion<SettingRow>(db, {
    table: 'sys_settings',
    idColumn: 'key',
    id: setting.key,
    expectedVersion: setting.expectedVersion,
    patch: { value: JSON.stringify(setting.value) },
    actorUserId: setting.actor,
  });
}
