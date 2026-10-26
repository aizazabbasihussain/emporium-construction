import { variationsPermissionGrants, variationsPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVariationsKit, type VariationsKit } from './test-support.js';

let kit: VariationsKit;
beforeAll(async () => {
  kit = await createVariationsKit();
}, 60_000);
afterAll(() => kit.close());

describe('variations permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(variationsPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...variationsPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: project managers and management act, a supervisor only creates drafts', () => {
    for (const [permission, roles] of Object.entries(variationsPermissionGrants)) {
      expect(roles, permission).toContain('management');
      expect(roles, permission).toContain('project_manager');
      expect(roles, permission).not.toContain('accountant');
    }
    expect(variationsPermissionGrants['variations.variation.create']).toContain('supervisor');
    expect(variationsPermissionGrants['variations.variation.read']).not.toContain('supervisor');
    expect(variationsPermissionGrants['variations.variation.update']).not.toContain('supervisor');
    expect(variationsPermissionGrants['variations.variation.client_approve']).not.toContain(
      'supervisor',
    );
  });

  it('every variations table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'var\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'var_counters',
      'var_lines',
      'var_status_history',
      'var_variations',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });
});
