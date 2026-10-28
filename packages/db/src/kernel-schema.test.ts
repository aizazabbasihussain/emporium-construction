import { beforeAll, describe, expect, it } from 'vitest';
import { findTablesWithoutRls } from './rls.js';
import { createTestDb } from './test-db.js';
import type { SqlDb } from './types.js';
import { updateWithVersion } from './versioned.js';

const ID = '018f0000-0000-7000-8000-000000000001';
let db: SqlDb;

beforeAll(async () => {
  db = await createTestDb();
});

describe('platform kernel schema (P1-01)', () => {
  it('has RLS deny-all on every table (constitution 7.7)', async () => {
    expect(await findTablesWithoutRls(db)).toEqual([]);
  });

  it('seeds the H-27 number series and the backdating setting', async () => {
    const series = await db.query<{ code: string; prefix: string; gapless: boolean }>(
      'select code, prefix, gapless from sys_number_series order by code',
    );
    // The H-27 document series, the party series added by P1-05 and the lead series of P1-06, the estimate series of P1-07 and the transfer and count series of P1-12.
    expect(series.map((s) => s.prefix).sort()).toEqual([
      'CL',
      'CNT',
      'EST',
      'INV',
      'LC',
      'LEAD',
      'PO',
      'PRJ',
      'PV',
      'QUO',
      'RV',
      'SC',
      'STR',
      'VAR',
      'VN',
    ]);
    expect(series.find((s) => s.code === 'invoice')?.gapless).toBe(true);
    const [setting] = await db.query<{ value: number }>(
      "select value from sys_settings where key = 'backdating_days'",
    );
    expect(setting?.value).toBe(3);
  });

  it('keeps audit rows immutable (T-6, AC-4)', async () => {
    await db.query(
      "insert into sys_audit_log (id, action, entity_type) values ($1, 'x', 'thing')",
      [ID],
    );
    await expect(db.query("update sys_audit_log set action = 'y'")).rejects.toThrow(/append-only/);
    await expect(db.query('delete from sys_audit_log')).rejects.toThrow(/append-only/);
    await expect(db.exec('truncate sys_audit_log')).rejects.toThrow(/append-only/);
    expect(await db.query('select id from sys_audit_log')).toHaveLength(1);
  });

  it('enforces one idempotency row per key and user and one consumption per event handler', async () => {
    const insertKey = (user: string) =>
      db.query(
        "insert into sys_idempotency (key, user_id, request_hash, status_code) values ('k', $1, 'h', 200)",
        [user],
      );
    await insertKey(ID);
    await insertKey('018f0000-0000-7000-8000-000000000002');
    await expect(insertKey(ID)).rejects.toThrow();
    await db.query("insert into sys_outbox (id, type, payload) values ($1, 't', '{}')", [ID]);
    const consume = () =>
      db.query("insert into sys_event_consumptions (event_id, handler) values ($1, 'h')", [ID]);
    await consume();
    await expect(consume()).rejects.toThrow();
  });
});

describe('updateWithVersion (BR-10, T-7)', () => {
  const patchPrefix = (expectedVersion: number, prefix = 'ZZ') =>
    updateWithVersion<{ prefix: string; version: number }>(db, {
      table: 'sys_number_series',
      idColumn: 'code',
      id: 'quotation',
      expectedVersion,
      patch: { prefix },
      actorUserId: ID,
    });

  it('updates, increments the version and stamps the actor', async () => {
    const row = await patchPrefix(1);
    expect(row).toMatchObject({ prefix: 'ZZ', version: 2, updated_by: ID });
  });

  it('returns a conflict when the version differs', async () => {
    await expect(patchPrefix(1)).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('reports a missing row and rejects unsafe input', async () => {
    await expect(
      updateWithVersion(db, {
        table: 'sys_number_series',
        idColumn: 'code',
        id: 'missing',
        expectedVersion: 1,
        patch: { prefix: 'A' },
      }),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      updateWithVersion(db, { table: 'x; drop', id: ID, expectedVersion: 1, patch: { a: 1 } }),
    ).rejects.toMatchObject({ code: 'invalid_identifier' });
    await expect(
      updateWithVersion(db, {
        table: 'sys_number_series',
        id: ID,
        expectedVersion: 1,
        patch: { version: 9 },
      }),
    ).rejects.toMatchObject({ code: 'protected_column' });
  });
});

describe('identity schema (P1-02)', () => {
  it('seeds the nine roles and the minimal admin-only permission map (BR-8)', async () => {
    const roles = await db.query<{ code: string; system: boolean }>(
      'select code, system from sys_roles order by code',
    );
    expect(roles.map((r) => r.code)).toEqual([
      'accountant',
      'admin',
      'estimator',
      'management',
      'procurement',
      'project_manager',
      'service_coordinator',
      'storekeeper',
      'supervisor',
    ]);
    expect(roles.every((r) => r.system)).toBe(true);
    const grants = await db.query<{ role_code: string; permission_code: string }>(
      "select role_code, permission_code from sys_role_permissions where permission_code like 'identity.%' order by 1, 2",
    );
    expect(grants).toEqual([
      { role_code: 'admin', permission_code: 'identity.role.manage' },
      { role_code: 'admin', permission_code: 'identity.user.manage' },
      { role_code: 'admin', permission_code: 'identity.user.read' },
      { role_code: 'management', permission_code: 'identity.user.read' },
    ]);
  });

  it('keeps emails lower case and unique and subjects unique', async () => {
    const insert = (id: string, email: string, subject: string | null) =>
      db.query(
        "insert into sys_users (id, auth_subject, email, full_name) values ($1, $2, $3, 'N')",
        [id, subject, email],
      );
    await insert('018f0000-0000-7000-8000-0000000000a1', 'one@example.test', 's1');
    await expect(
      insert('018f0000-0000-7000-8000-0000000000a2', 'One@example.test', null),
    ).rejects.toThrow();
    await expect(
      insert('018f0000-0000-7000-8000-0000000000a3', 'one@example.test', null),
    ).rejects.toThrow();
    await expect(
      insert('018f0000-0000-7000-8000-0000000000a4', 'two@example.test', 's1'),
    ).rejects.toThrow();
    await db.query("delete from sys_users where id = '018f0000-0000-7000-8000-0000000000a1'");
  });
});
