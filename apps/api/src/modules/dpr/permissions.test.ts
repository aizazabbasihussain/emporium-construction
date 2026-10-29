import { dprPermissionGrants, dprPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDprKit, type DprKit } from './test-support.js';

let kit: DprKit;
beforeAll(async () => {
  kit = await createDprKit();
}, 60_000);
afterAll(() => kit.close());

describe('dpr permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(dprPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...dprPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: supervisors and managers report, managers and management review', () => {
    const grants = dprPermissionGrants;
    for (const role of ['supervisor', 'project_manager']) {
      expect(grants['dpr.report.create'], role).toContain(role);
      expect(grants['dpr.report.update_own'], role).toContain(role);
    }
    expect(grants['dpr.report.read']).toEqual(
      expect.arrayContaining(['supervisor', 'project_manager', 'management', 'accountant']),
    );
    expect(grants['dpr.report.review']).toEqual(['project_manager', 'management']);
    expect(grants['dpr.report.review']).not.toContain('supervisor');
    expect(grants['dpr.report.create']).not.toContain('accountant');
  });

  it('every dpr table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'dpr\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'dpr_material_notes',
      'dpr_missing_runs',
      'dpr_reports',
      'dpr_task_updates',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });

  it('knows the two settings of the module', async () => {
    expect((await kit.platform.settings.get(kit.db, 'dpr_photo_required')).value).toBe(true);
    expect((await kit.platform.settings.get(kit.db, 'site_holidays')).value).toBe('');
  });
});
