import { accountingPermissionGrants, accountingPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccountingKit, type AccountingKit } from './test-support.js';

let kit: AccountingKit;
beforeAll(async () => {
  kit = await createAccountingKit();
}, 120_000);
afterAll(() => kit.close());

describe('accounting permissions (spec section 6)', () => {
  // Migration 0023 gives admin every permission it knew then; this migration grants admin its own.
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(accountingPermissions)) {
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
      ).toEqual([...accountingPermissionGrants[permission]].sort());
      expect(
        rows.map((r) => r.role_code),
        `${permission} for admin`,
      ).toContain('admin');
    }
  });

  it('follows the spec: export to accountant and management, tags and rules to the accountant', () => {
    const grants = accountingPermissionGrants;
    expect(grants['accounting.export.run']).toEqual(['accountant', 'management']);
    expect(grants['accounting.export.read']).toEqual(['accountant', 'management']);
    expect(grants['accounting.tag.manage']).toEqual(['accountant']);
    expect(grants['accounting.rules.manage']).toEqual(['accountant']);
  });

  it('every permission code has the three-part format of the role table', () => {
    for (const code of Object.values(accountingPermissions)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$/);
    }
  });
});
