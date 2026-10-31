import { workerportalPermissionGrants, workerportalPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPortalKit, type PortalKit } from './test-support.js';

let kit: PortalKit;
beforeAll(async () => {
  kit = await createPortalKit();
}, 60_000);
afterAll(() => kit.close());

describe('workerportal permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(workerportalPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...workerportalPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: the worker reads their own records and only the admin links', () => {
    expect(workerportalPermissionGrants['workerportal.self.read']).toEqual(['worker']);
    expect(workerportalPermissionGrants['workerportal.account.manage']).toEqual(['admin']);
  });

  it('seeds the worker role', async () => {
    const roles = await kit.identity.roles.list(kit.db);
    expect(roles.find((role) => role.code === 'worker')).toMatchObject({
      name: 'Worker',
      permissions: ['workerportal.self.read'],
    });
  });

  it('every workerportal table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'wkp\\_%'`,
    );
    expect(tables).toEqual([{ relname: 'wkp_worker_accounts', relrowsecurity: true }]);
  });
});
