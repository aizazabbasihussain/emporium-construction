import { profitabilityPermissionGrants, profitabilityPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProfitabilityKit, type ProfitabilityKit } from './test-support.js';

let kit: ProfitabilityKit;
beforeAll(async () => {
  kit = await createProfitabilityKit();
}, 120_000);
afterAll(() => kit.close());

describe('profitability permissions (spec section 6)', () => {
  // Migration 0023 gives admin every permission it knew then; this migration grants admin its own.
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(profitabilityPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(
        rows
          .map((r) => r.role_code)
          .filter((code) => code !== 'admin')
          .sort(),
        permission,
      ).toEqual([...profitabilityPermissionGrants[permission]].sort());
      expect(
        rows.map((r) => r.role_code),
        `${permission} for admin`,
      ).toContain('admin');
    }
  });

  it('follows the spec and gives a supervisor none', () => {
    const grants = profitabilityPermissionGrants;
    expect(grants['profitability.project.read']).toEqual([
      'management',
      'accountant',
      'project_manager',
    ]);
    expect(grants['profitability.forecast.set']).toEqual(['project_manager', 'management']);
    expect(grants['profitability.threshold.manage']).toEqual(['management']);
    for (const roles of Object.values(grants)) expect(roles).not.toContain('supervisor');
  });

  it('every permission code has the three-part format of the role table', () => {
    for (const code of Object.values(profitabilityPermissions)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$/);
    }
  });
});
