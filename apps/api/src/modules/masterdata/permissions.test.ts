import { masterdataPermissionGrants, masterdataPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMasterKit, type MasterKit } from './test-support.js';

let kit: MasterKit;
beforeAll(async () => {
  kit = await createMasterKit();
}, 60_000);
afterAll(() => kit.close());

describe('master data permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(masterdataPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...masterdataPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: admin company, procurement price, accountant and management cost codes', () => {
    expect(masterdataPermissionGrants['master.company.manage']).toEqual(['admin']);
    expect(masterdataPermissionGrants['master.price.manage']).toContain('procurement');
    expect(masterdataPermissionGrants['master.costcode.manage']).toEqual(
      expect.arrayContaining(['accountant', 'management']),
    );
    expect(masterdataPermissionGrants['master.item.manage']).not.toContain('storekeeper');
    expect(masterdataPermissionGrants['master.item.read']).toContain('storekeeper');
    // Supervisors read parties only through project context (spec section 6).
    expect(masterdataPermissionGrants['master.party.read']).not.toContain('supervisor');
  });

  it('every table is covered by row level security', async () => {
    const rows = await kit.db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'mst\\_%'
          and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });
});
