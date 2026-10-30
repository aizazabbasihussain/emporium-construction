import { workforcePermissionGrants, workforcePermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkforceKit, type WorkforceKit } from './test-support.js';

let kit: WorkforceKit;
beforeAll(async () => {
  kit = await createWorkforceKit();
}, 60_000);
afterAll(() => kit.close());

describe('workforce permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(workforcePermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...workforcePermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: only accountant and management see or set pay (BR-7)', () => {
    const grants = workforcePermissionGrants;
    expect(grants['workforce.rate.read']).toEqual(['accountant', 'management']);
    expect(grants['workforce.rate.manage']).toEqual(['accountant', 'management']);
    expect(grants['workforce.worker.read']).toContain('supervisor');
    expect(grants['workforce.worker.manage']).not.toContain('supervisor');
    expect(grants['workforce.team.manage']).toEqual(['management', 'project_manager']);
  });

  it('every workforce table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'lab\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'lab_pay_rates',
      'lab_team_members',
      'lab_teams',
      'lab_trades',
      'lab_workers',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });

  it('knows the working-days setting, 26 until the owner answers H-11', async () => {
    expect((await kit.platform.settings.get(kit.db, 'workforce.working_days_basis')).value).toBe(
      26,
    );
  });
});
