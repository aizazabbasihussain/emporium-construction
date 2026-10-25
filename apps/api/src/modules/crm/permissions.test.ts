import { crmPermissionGrants, crmPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCrmKit, type CrmKit } from './test-support.js';

let kit: CrmKit;
beforeAll(async () => {
  kit = await createCrmKit();
}, 60_000);
afterAll(() => kit.close());

describe('crm permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(crmPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...crmPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: sales roles manage, the accountant reads, supervisors have nothing', () => {
    for (const permission of Object.values(crmPermissions)) {
      expect(crmPermissionGrants[permission], permission).not.toContain('supervisor');
    }
    expect(crmPermissionGrants['crm.lead.read']).toContain('accountant');
    for (const permission of Object.values(crmPermissions)) {
      if (permission !== 'crm.lead.read') {
        expect(crmPermissionGrants[permission], permission).not.toContain('accountant');
      }
    }
    for (const role of ['management', 'project_manager', 'service_coordinator']) {
      expect(crmPermissionGrants['crm.visit.manage']).toContain(role);
      expect(crmPermissionGrants['crm.followup.manage']).toContain(role);
    }
    expect(crmPermissionGrants['crm.lead.reopen']).toEqual(['admin', 'management']);
  });

  it('every crm table has row level security', async () => {
    const rows = await kit.db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'crm\\_%'
          and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
    const tables = await kit.db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'crm\\_%'`,
    );
    expect(tables).toHaveLength(7);
  });
});
