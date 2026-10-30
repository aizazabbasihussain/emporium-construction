import { reportsPermissionGrants, reportsPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReportsKit, type ReportsKit } from './test-support.js';

vi.setConfig({ testTimeout: 60_000 });

let kit: ReportsKit;
beforeAll(async () => {
  kit = await createReportsKit();
}, 120_000);
afterAll(() => kit.close());

describe('reports permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(reportsPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...reportsPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec and gives a supervisor none', () => {
    const grants = reportsPermissionGrants;
    expect(grants['reports.project_cost.read']).toEqual([
      'management',
      'project_manager',
      'accountant',
    ]);
    expect(grants['reports.stock.read']).toEqual([
      'storekeeper',
      'procurement',
      'management',
      'accountant',
    ]);
    expect(grants['reports.purchasing.read']).toEqual(['procurement', 'management']);
    expect(grants['reports.labour.read']).toEqual(['management', 'accountant']);
    expect(grants['reports.dpr.read']).toEqual(['project_manager', 'management']);
    expect(grants['reports.pipeline.read']).toEqual(['management', 'project_manager']);
    for (const roles of Object.values(grants)) expect(roles).not.toContain('supervisor');
  });

  it('every reports table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'rpt\\_%'`,
    );
    expect(tables.map((t) => t.relname)).toEqual(['rpt_saved_filters']);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });

  it('keeps one live saved filter per user, report and name', async () => {
    await kit.db.query(
      `insert into sys_users (id, auth_subject, email, full_name) values ($1, 'u', 'u@example.test', 'U')`,
      ['018f7a7a-0000-7000-8000-000000000001'],
    );
    const insert = (name: string) =>
      kit.db.query(
        `insert into rpt_saved_filters (id, user_id, report_code, name) values (gen_random_uuid(), $1, 'stock', $2)`,
        ['018f7a7a-0000-7000-8000-000000000001', name],
      );
    await insert('Same');
    await expect(insert('same')).rejects.toThrow();
    await expect(
      kit.db.query(
        `insert into rpt_saved_filters (id, user_id, report_code, name) values (gen_random_uuid(), $1, 'nothing', 'x')`,
        ['018f7a7a-0000-7000-8000-000000000001'],
      ),
    ).rejects.toThrow();
  });
});
